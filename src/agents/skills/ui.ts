/**
 * Skills in the app (plan W7.1): `/` in the AI prompt and in the command
 * palette lists them; choosing one runs it on the open note through the
 * agent runtime. Loaded on demand (nothing here is in the startup bundle).
 *
 * The skill's answer is staged as a new note under `skills/<name>/`, and
 * the review screen opens: like every change a skill makes, it is written
 * only when the user approves it (plan 5.11).
 */
import { t, getLocale } from "../../i18n";
import { useAppStore } from "../../store/useStore";
import { getVaultBackend } from "../../storage/vault";
import { stageChange } from "../staging";
import { allowedStore, loadSkills, matchSkills, parseSlash, type SkillStore } from "./library";
import { runSkill, SkillRefusedError } from "./run";
import { isTrusted, skillTitle, sourceLabel, type Skill } from "./skillFile";
import "./strings";

/** The vault's `.lumen/skills` through the storage backend. */
export function workspaceSkillStore(): SkillStore {
  const v = getVaultBackend();
  return {
    listDirs: async (path) => (await v.list(path)).filter((e) => e.kind === "directory").map((e) => e.name).sort(),
    read: async (path) => (await v.read(path)).text(),
  };
}

export async function availableSkills(): Promise<Skill[]> {
  let store: SkillStore | null = null;
  try {
    store = workspaceSkillStore();
  } catch {
    store = null; // no vault open: the starters only
  }
  // A vault that came with git (a clone, a shared repository) is someone else's: its skills are outside ones (review 21, D1).
  let sharedFrom: string | undefined;
  try {
    if (store && (await getVaultBackend().stat(".git"))) sharedFrom = "a git repository";
  } catch {
    sharedFrom = undefined;
  }
  return (await loadSkills(store, sharedFrom ? { sharedFrom } : {})).skills;
}

/** The palette's items for a `/` query. */
export async function skillPaletteItems(query: string): Promise<Array<{ id: string; label: string; hint: string; action: () => void }>> {
  const locale = getLocale();
  return matchSkills(await availableSkills(), query).map((s) => ({
    id: `skill:${s.name}`,
    label: `/${s.name} — ${skillTitle(s, locale)}`,
    hint: isTrusted(s.source) ? s.description : `${t("skills.untrustedBadge")} · ${s.description}`,
    action: () => void runSkillFromUi(s, parseSlash(query)?.request ?? ""),
  }));
}

/** `/name request` typed in the AI prompt: run it. False when it names no skill. */
export async function runSlashCommand(input: string): Promise<boolean> {
  const p = parseSlash(input);
  if (!p) return false;
  const skill = (await availableSkills()).find((s) => s.name === p.name);
  if (!skill) return false;
  await runSkillFromUi(skill, p.request);
  return true;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");

export async function runSkillFromUi(skill: Skill, request: string): Promise<void> {
  const { showAiToast } = await import("../../ui/AiToast");
  const { uiConfirm } = await import("../../ui/PromptDialog");
  const doc = useAppStore.getState().doc;
  const title = skillTitle(skill, getLocale());
  showAiToast(t("skills.running", { name: title }), "info");
  try {
    const run = await runSkill(
      skill,
      { text: request, path: doc.workspaceName ?? null },
      {
        document: doc.content,
        path: doc.workspaceName ?? null,
        allowed: allowedStore(),
        confirmFirstRun: (s) =>
          uiConfirm({
            title: t("skills.untrusted.title", { name: s.name }),
            message: t("skills.untrusted.message", { source: sourceLabel(s.source), tools: s.allowedTools.join(", ") || "—" }),
            okLabel: t("skills.untrusted.ok"),
          }),
      },
    );
    if (run.errorCode === "skill-refused") return;
    if (run.status !== "ok" || typeof run.output !== "string") {
      showAiToast(t("skills.failed", { name: title, error: run.error ?? run.status }), "error");
      return;
    }
    let staged = run.staged?.length ?? 0;
    if (run.output.trim()) {
      stageChange(
        { kind: "file", path: `skills/${skill.name}/${stamp(new Date())}.md`, before: null, after: `# ${title}\n\n${run.output.trim()}\n`, summary: t("skills.answerSummary", { name: title }) },
        { tool: `skill:${skill.name}`, runId: run.id, agentId: `skill:${skill.name}` },
      );
      staged++;
    }
    showAiToast(t("skills.done", { name: title, n: String(staged) }), "info");
    if (staged) window.dispatchEvent(new Event("lumen-open-agent-review"));
  } catch (e) {
    if (e instanceof SkillRefusedError) return;
    showAiToast(t("skills.failed", { name: title, error: (e as Error)?.message ?? String(e) }), "error");
  }
}
