/** The datagov commands' bodies, loaded on first use (split out of datagov.ts for the startup budget, W4.9). */
import { t } from "../../i18n";
import { uiAlert, uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";
import type { CommandContext } from "./context";
import { explainError } from "../../lib/userError";
import { isSourceEnabled, setSourceEnabled } from "../../sources/open/gate";

type DataGov = typeof import("../../sources/datagov/app");
const datagov = (): Promise<DataGov> => import("../../sources/datagov/app");

async function ensureOn(): Promise<boolean> {
  if (isSourceEnabled("datagov")) return true;
  if (!(await uiConfirm({ message: t("datagov.enable") }))) return false;
  setSourceEnabled("datagov", true);
  return true;
}

const fail = (e: unknown) => useToastStore.getState().push({ kind: "error", title: t("datagov.failed", { error: explainError(e) }) });

async function inserted(ctx: CommandContext, r: { markdown: string; rows: number; personal: string[]; block: { title: string } }) {
  if (r.personal.length && !(await uiConfirm({ message: t("datagov.personal", { columns: r.personal.join(", ") }) }))) return;
  ctx.insertSnippet(`\n\n${r.markdown}\n`);
  useToastStore.getState().push({ kind: "success", title: t("datagov.inserted", { title: r.block.title, rows: r.rows }) });
}

/** The ```dataset block around the cursor: its body and its range. */
function blockAtCursor(ctx: CommandContext): { body: string; from: number; to: number } | null {
  const view = ctx.getEditorView?.();
  if (!view) return null;
  const doc = view.state.doc.toString();
  const pos = view.state.selection.main.from;
  const re = /```dataset\n([\s\S]*?)\n```/g;
  for (const m of doc.matchAll(re)) {
    const from = m.index ?? 0;
    let to = from + m[0].length;
    // The attribution line under the block belongs to it: a refresh rewrites both.
    const credit = /^\n\n(?:הלשכה המרכזית לסטטיסטיקה|מקור: data\.gov\.il)[^\n]*/.exec(doc.slice(to));
    if (pos >= from && pos <= to + (credit?.[0].length ?? 0)) {
      if (credit) to += credit[0].length;
      return { body: m[1], from, to };
    }
  }
  return null;
}

export async function datagovInsert(ctx: CommandContext): Promise<void> {
  const d = await datagov();
  const q = (await uiPrompt({ message: t("datagov.prompt"), defaultValue: "" }))?.trim();
  if (!q || !(await ensureOn())) return;
  const confirm = () => uiConfirm({ message: t("datagov.confirm", { query: q }) });
  try {
    const hits = await d.search(q, confirm);
    if (hits === null) return;
    if (!hits.length) {
      await uiAlert({ message: t("datagov.none", { query: q }) });
      return;
    }
    const name = await uiSelect({ message: t("datagov.pickDataset"), choices: hits.map((h) => ({ value: h.name, label: `${h.title}${h.organization ? ` — ${h.organization}` : ""}` })) });
    const hit = hits.find((h) => h.name === name);
    if (!hit) return;
    const tables = hit.resources.filter((r) => r.datastore);
    if (!tables.length) {
      await uiAlert({ message: t("datagov.noTable") });
      return;
    }
    const rid = tables.length === 1 ? tables[0].id : await uiSelect({ message: t("datagov.pickResource"), choices: tables.map((r) => ({ value: r.id, label: `${r.name} (${r.format})` })) });
    if (!rid) return;
    // The search was confirmed; fetching the rows is the same action.
    const r = await d.addResource(hit, rid, async () => true);
    if (r) await inserted(ctx, r);
  } catch (e) {
    fail(e);
  }
}

export async function cbsSeries(ctx: CommandContext): Promise<void> {
  const d = await datagov();
  const id = (await uiPrompt({ message: t("datagov.seriesPrompt"), defaultValue: "120010" }))?.trim();
  if (!id || !/^\d+$/.test(id) || !(await ensureOn())) return;
  try {
    const r = await d.addSeries(id, () => uiConfirm({ message: t("datagov.confirmSeries", { id }) }));
    if (r) await inserted(ctx, r);
  } catch (e) {
    fail(e);
  }
}

export async function datasetRefresh(ctx: CommandContext): Promise<void> {
  const d = await datagov();
  const at = blockAtCursor(ctx);
  if (!at) {
    await uiAlert({ message: t("datagov.noBlock") });
    return;
  }
  if (!(await ensureOn())) return;
  try {
    const r = await d.refresh(at.body, () => uiConfirm({ message: t("datagov.confirmRefresh") }));
    if (!r) return;
    const none = !r.diff.added.length && !r.diff.removed.length && !r.diff.changed.length && !r.diff.columnsChanged;
    const ok = await uiConfirm({ message: none ? t("datagov.unchanged") : `${t("datagov.changes")}\n\n${d.diffSummary(r.diff, r.header)}` });
    if (!ok) return;
    const view = ctx.getEditorView?.();
    view?.dispatch({ changes: { from: at.from, to: at.to, insert: r.after.markdown.trimEnd() }, userEvent: "input" });
  } catch (e) {
    fail(e);
  }
}
