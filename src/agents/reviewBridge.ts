/**
 * Agent review (plan 5.11) wired to the app. Loaded after startup by
 * hooks/useAgentReview, so none of it is in the startup bundle:
 *  - registers the editor as the document applier, so approving a change
 *    to an open document applies it to the live text (through CodeMirror
 *    when it shows the document: in the undo history; and the document
 *    becomes unsaved), not to the file underneath it;
 *  - keeps the open documents' keys (`documentKeys.ts`) and gives the
 *    runtime the active one (`docKey.ts`), so a run's changes go to the
 *    document it worked on;
 *  - reports how many changes wait for review (the status-bar badge);
 *  - announces new proposals with a toast that opens the review panel;
 *  - adds `agentReview` to the e2e test surface (`window.__lumen`).
 */

import type { RefObject } from "react";
import type { EditorHandle } from "../editor/Editor";
import { createDocumentApplier, type DocumentHost } from "./documentApplier";
import { createDocumentKeys, type DocumentKeys } from "./documentKeys";
import { currentDocumentKey, setDocumentKeyProvider } from "./docKey";
import { discardRunChanges, getStagedChange, listStagedChanges, onStagedChanges, rangeContext, setDocumentApplier, stageChange, textFingerprint } from "./staging";
import type { ChangeProposal, StagedChange } from "./types";
import { flushPendingEdits, tabIdOf, useAppStore } from "../store/useStore";
import { showAiToast } from "../ui/AiToast";
import { t, tPlural } from "../i18n";

/** The open documents' keys, following the store (`stop` unsubscribes). */
export function trackDocumentKeys(): DocumentKeys & { stop(): void } {
  const keys = createDocumentKeys();
  keys.observe(useAppStore.getState());
  const stop = useAppStore.subscribe((state) => keys.observe(state));
  return {
    ...keys,
    // Read through the store's current state: a change made in this tick is seen.
    active: () => (keys.observe(useAppStore.getState()), keys.active()),
    tab: (id) => (keys.observe(useAppStore.getState()), keys.tab(id)),
    stop,
  };
}

/** The store and the CodeMirror view, as the applier sees them. */
export function editorDocumentHost(editorRef: RefObject<EditorHandle | null>, keys: Pick<DocumentKeys, "active" | "tab">): DocumentHost {
  return {
    active() {
      // The WYSIWYG editor debounces its output: make it emit first.
      flushPendingEdits();
      const { doc } = useAppStore.getState();
      return { path: doc.workspaceName ?? null, text: doc.content, key: keys.active() };
    },
    tabs() {
      const { doc, openTabs } = useAppStore.getState();
      const active = tabIdOf(doc);
      return openTabs.filter((tab) => tab.id !== active).map((tab) => ({ id: tab.id, path: tab.workspaceName ?? null, text: tab.content, key: keys.tab(tab.id) }));
    },
    editActive(edit) {
      const { doc, setContent } = useAppStore.getState();
      const view = editorRef.current?.getView();
      if (view && view.state.doc.toString() === doc.content) {
        // Through CodeMirror: undoable, and its onChange marks the document
        // unsaved. Not an "input" event, so suggesting mode's filter leaves
        // it as it is (a tracked change was already written by the applier).
        view.dispatch({ changes: edit, userEvent: "agent.apply", selection: { anchor: edit.from + edit.insert.length }, scrollIntoView: true });
        return true;
      }
      // Preview / WYSIWYG: no editor history to put it in (WYSIWYG rebuilds
      // from the new text), so the result says Undo cannot take it back.
      setContent(doc.content.slice(0, edit.from) + edit.insert + doc.content.slice(edit.to));
      return false;
    },
    setTab(id, text) {
      useAppStore.setState((s) => ({ openTabs: s.openTabs.map((tab) => (tab.id === id ? { ...tab, content: text, dirty: true } : tab)) }));
    },
    suggesting: () => useAppStore.getState().suggestingMode,
  };
}

/** Start the always-on part; returns the function that stops it. */
export function startAgentReview(opts: { editorRef: RefObject<EditorHandle | null>; onPending: (count: number) => void; openPanel: () => void }): () => void {
  const keys = trackDocumentKeys();
  setDocumentKeyProvider(keys.active);
  setDocumentApplier(createDocumentApplier(editorDocumentHost(opts.editorRef, keys)));
  const seen = new Set<string>();
  let fresh: StagedChange[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const announce = () => {
    timer = undefined;
    const batch = fresh.filter((c) => getStagedChange(c.id)?.status === "pending");
    fresh = [];
    if (!batch.length) return;
    const agents = [...new Set(batch.map((c) => c.agentId).filter(Boolean))].join(", ") || t("agentReview.unknownAgent");
    showAiToast(tPlural("agentReview.toast", batch.length, { agent: agents }), "info", {
      action: { label: t("agentReview.toast.review"), onClick: opts.openPanel },
    });
  };
  const onList = (list: readonly StagedChange[]) => {
    let n = 0;
    for (const c of list) {
      if (c.status !== "pending") continue;
      n++;
      if (!seen.has(c.id)) {
        seen.add(c.id);
        fresh.push(c);
      }
    }
    opts.onPending(n);
    // One toast for a burst of proposals (a run stages them a few at a time).
    if (fresh.length && !timer) timer = setTimeout(announce, 400);
  };
  onList(listStagedChanges({ all: true }));
  const off = onStagedChanges(onList);
  const surface = window as unknown as { __lumen?: Record<string, unknown> };
  (surface.__lumen ??= {}).agentReview = { stage: stageForTest, withdrawRun: discardRunChanges };
  return () => {
    off();
    if (timer) clearTimeout(timer);
    setDocumentApplier(null);
    setDocumentKeyProvider(null);
    keys.stop();
    delete surface.__lumen?.agentReview;
  };
}

/**
 * The e2e test surface (`window.__lumen.agentReview.stage`): stage a
 * proposal the way an agent's write tool and the runtime do — a range
 * with its surroundings, the open document's fingerprint and key. Staging
 * writes nothing; the change waits for approval in the panel. (No shipped
 * command grants agents the write scope yet, plan 5.3, so e2e cannot get
 * a real run to propose a change.)
 */
export function stageForTest(proposal: ChangeProposal, meta: { tool?: string; runId?: string; agentId?: string } = {}): string {
  const doc = useAppStore.getState().doc.content;
  const staged =
    proposal.kind === "range"
      ? {
          ...proposal,
          context: proposal.context ?? rangeContext(doc, proposal.from, proposal.to),
          basis: proposal.basis ?? textFingerprint(doc),
          docKey: proposal.docKey ?? currentDocumentKey(),
        }
      : proposal;
  return stageChange(staged, { tool: meta.tool ?? (proposal.kind === "range" ? "replace_range" : "write_file"), runId: meta.runId, agentId: meta.agentId }).id;
}
