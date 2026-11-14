/**
 * A git pull and the open notes (plan 3.3).
 *
 * - `pullEditorHooks()` tells the pull (src/sync/gitPull.ts) what each open
 *   note holds — after flushing the editors, so the last keystrokes count —
 *   and lets it put merged text into a note: a clean note shows the new file,
 *   a note with unsaved edits gets the merge in the editor (still unsaved, saved
 *   by autosave) and is never written behind the user's back.
 * - `resolveGitConflicts()` is the resolution screen: the three-way conflict
 *   dialog (the one cloud sync and outside changes use), one file at a time.
 *   A file left unresolved keeps its conflict markers, and committing refuses
 *   until they are gone.
 */
import { t } from "../i18n";
import { log } from "../lib/logger";
import { writeWorkspaceFile } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import type { PendingConflict } from "../sync/gitPull";
import type { PullEditorHooks, PullResult } from "../sync/git";
import { showAiToast } from "../ui/AiToast";
import { uiAlert, uiPrompt } from "../ui/PromptDialog";
import { flushPendingEdits, useAppStore } from "./useStore";
import { flushActiveWorkspaceDoc } from "./openDocs";

/** The open note (active document or a tab) at a vault path. */
function openNote(path: string): { content: string; dirty: boolean } | null {
  const s = useAppStore.getState();
  if (s.doc.workspaceName === path) return { content: s.doc.content, dirty: s.doc.dirty };
  const tab = s.openTabs.find((x) => x.workspaceName === path);
  return tab ? { content: tab.content, dirty: tab.dirty } : null;
}

function setNote(path: string, content: string, dirty: boolean): void {
  useAppStore.setState((state) => {
    const doc = state.doc.workspaceName === path ? { ...state.doc, content, dirty } : state.doc;
    const openTabs = state.openTabs.map((tab) => (tab.workspaceName === path ? { ...tab, content, dirty } : tab));
    return { doc, openTabs };
  });
}

export function pullEditorHooks(): PullEditorHooks {
  flushPendingEdits();
  return {
    openNote: (path) => {
      flushPendingEdits();
      return openNote(path);
    },
    setOpenNote: (path, text) => setNote(path, text, true),
    onWritten: (path, text) => {
      const note = openNote(path);
      // Only a clean note follows the file; one with edits was not written.
      if (note && !note.dirty && text !== null) setNote(path, text, false);
    },
  };
}

/**
 * Save every open note that has unsaved edits — the active one and every
 * tab — through the compare-and-swap save (plan 4.4), before a commit reads
 * the vault (Codex P1 on #269: a merge put into an inactive dirty tab is
 * otherwise never written, since autosave covers the active note only).
 * Returns the vault paths that could not be saved: a change made outside
 * Lumen is being resolved for them, so the commit leaves them out.
 */
export async function flushOpenNotes(): Promise<string[]> {
  flushPendingEdits();
  const left: string[] = [];
  const s = useAppStore.getState();
  if (s.doc.dirty && s.doc.workspaceName) {
    try {
      await flushActiveWorkspaceDoc();
    } catch (err) {
      log.warn("git: the active note could not be saved before the commit", err);
    }
    if (useAppStore.getState().doc.dirty && useAppStore.getState().doc.workspaceName === s.doc.workspaceName) left.push(s.doc.workspaceName);
  }
  const { saveOpenNote } = await import("./externalChanges");
  for (const tab of useAppStore.getState().openTabs) {
    if (!tab.dirty || !tab.workspaceName || tab.workspaceName === s.doc.workspaceName) continue;
    const { workspaceName: path, content } = tab;
    let ok = false;
    try {
      ok = await saveOpenNote(path, content);
    } catch (err) {
      log.warn("git: a tab could not be saved before the commit", path, err);
    }
    if (!ok) {
      left.push(path);
      continue;
    }
    // Clean only if the tab still holds what was written.
    const now = useAppStore.getState().openTabs.find((x) => x.workspaceName === path);
    if (now && now.content === content) setNote(path, content, false);
    notifyWorkspaceChanged({ kind: "content", paths: [path] });
  }
  return left;
}

export type GitConflictChoice = { kind: "merged"; content: string } | { kind: "local" } | { kind: "remote" } | null;
export type GitConflictUi = (o: { path: string; base: string; local: string; remote: string }) => Promise<GitConflictChoice>;

let conflictUi: GitConflictUi = async (o) => {
  const [{ openConflictDialog }, { mergeHunks }] = await Promise.all([import("../sync/cloud/ConflictDialog"), import("../sync/gitMerge")]);
  return openConflictDialog({
    ...o,
    // The same diff3 hunks the pull used: a deletion against an edit shows
    // as a conflict to pick, never as a silent one-sided change.
    hunks: mergeHunks(o.base, o.local, o.remote),
    labels: {
      title: t("git.conflict.title", { path: o.path }),
      description: t("git.conflict.body"),
      local: t("git.conflict.mine"),
      remote: t("git.conflict.theirs"),
      takeLocal: t("git.conflict.takeMine"),
      takeRemote: t("git.conflict.takeTheirs"),
      merge: t("git.conflict.merge"),
      cancel: t("git.conflict.later"),
    },
  });
};

/** @internal tests */
export function __setGitConflictUi(ui: GitConflictUi): void {
  conflictUi = ui;
}

/**
 * Walk the user through each conflict. Returns the paths still unresolved
 * (their files keep the conflict markers; an open note keeps its text and
 * the other version stays in its copy).
 */
export async function resolveGitConflicts(conflicts: PendingConflict[]): Promise<string[]> {
  const left: string[] = [];
  for (const c of conflicts) {
    let choice: GitConflictChoice = null;
    try {
      choice = await conflictUi({ path: c.path, base: c.base, local: c.ours, remote: c.theirs });
    } catch (err) {
      log.warn("git conflict dialog failed", err);
    }
    if (!choice) {
      left.push(c.path);
      continue;
    }
    const text = choice.kind === "merged" ? choice.content : choice.kind === "local" ? c.ours : c.theirs;
    flushPendingEdits();
    const note = openNote(c.path);
    if (c.where === "open" && note) {
      // Typed on during the dialog: the newer text wins, the choice waits.
      if (note.content !== c.ours) {
        left.push(c.path);
        continue;
      }
      // Into the editor, unsaved: autosave writes it the usual way.
      setNote(c.path, text, true);
      continue;
    }
    // A note open with edits made since the pull is never written over.
    if (note?.dirty) {
      left.push(c.path);
      continue;
    }
    await writeWorkspaceFile(c.path, text);
    notifyWorkspaceChanged({ kind: "content", paths: [c.path] });
    if (note) setNote(c.path, text, false);
  }
  return left;
}

/** Tell what the pull did, then open the resolution screen for each conflict. */
export async function reportPull(result: PullResult): Promise<void> {
  const lines: string[] = [
    result.upToDate ? t("git.pull.upToDate") : t("git.pull.summary", { changed: result.changedFiles, conflicts: result.conflicts.length }),
  ];
  if (result.keptDeletedUpstream.length) {
    lines.push(t("git.pull.keptDeleted", { count: result.keptDeletedUpstream.length, files: result.keptDeletedUpstream.slice(0, 5).join(", ") }));
  }
  if (result.mergedIntoOpen.length) lines.push(t("git.pull.mergedIntoOpen", { files: result.mergedIntoOpen.join(", ") }));
  if (result.copies.length) lines.push(t("git.pull.copies", { files: result.copies.join(", ") }));
  if (result.kindClashes.length) lines.push(t("git.pull.kindClashes", { files: result.kindClashes.slice(0, 5).join(", ") }));
  const lfs = [...result.lfsSkipped, ...result.lfsPointers];
  if (lfs.length) lines.push(t("git.lfs.unsupported", { files: lfs.slice(0, 5).join(", ") }));
  await uiAlert({ message: lines.join("\n\n") });
  if (!result.conflicts.length) return;
  const left = await resolveGitConflicts(result.conflicts);
  // Remember what is still open, per repository: the next pull offers it again.
  const { setPendingConflicts } = await import("../sync/git");
  const repos = new Set(result.conflicts.map((c) => c.path.split("/")[0]));
  for (const repo of repos) {
    await setPendingConflicts(repo, result.conflicts.filter((c) => c.path.split("/")[0] === repo && left.includes(c.path)));
  }
  if (left.length) showAiToast(t("git.conflict.left", { count: left.length }), "info");
  else showAiToast(t("git.conflict.allResolved"), "success");
}

/** A failed clone / pull: add a hint when the request never reached the git host (CORS). */
export async function netError(e: unknown): Promise<string> {
  const msg = (e as Error).message;
  const { looksLikeCorsFailure } = await import("../sync/gitProxy");
  return looksLikeCorsFailure(e) ? `${msg}\n\n${t("git.alert.corsHint")}` : msg;
}

/** ⌘K → "Git: set CORS proxy…". */
export async function promptCorsProxy(): Promise<void> {
  const { getStoredCorsProxy, LOCAL_GIT_PROXY, normaliseProxyUrl, setStoredCorsProxy } = await import("../sync/gitProxy");
  const value = await uiPrompt({
    message: t("git.prompt.corsProxy"),
    defaultValue: getStoredCorsProxy() ?? "",
    placeholder: LOCAL_GIT_PROXY,
  });
  if (value === null) return;
  // A proxy the page's CSP does not allow would be blocked before the
  // request leaves: say so instead of saving a setting that fails.
  const url = normaliseProxyUrl(value);
  if (url) {
    const { connectAllowedByCsp } = await import("../lib/cspConnect");
    if (!connectAllowedByCsp(url)) {
      await uiAlert({ message: t("git.alert.corsProxyBlocked", { origin: new URL(url).origin }) });
      return;
    }
  }
  try {
    setStoredCorsProxy(value);
  } catch {
    await uiAlert({ message: t("git.alert.corsProxyInvalid") });
    return;
  }
  await uiAlert({ message: value.trim() ? t("git.alert.corsProxySaved") : t("git.alert.corsProxyCleared") });
}
