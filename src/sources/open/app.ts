/**
 * The app side of the open-sources dialog (plan W7.24): local sources read
 * from the vault, the online search behind one confirmation, and the
 * insertion each result's rights allow. Loaded with the dialog.
 */
import { ledgerFetch } from "../../ai/privacyLedger";
import { uiConfirm } from "../../ui/PromptDialog";
import { t } from "../../i18n";
import { enabledSources, gatedFetch, SourceOffError, type OpenSourceId } from "./gate";
import { insertionFor, searchLocal, searchOnline, type Kind, type LocalSources, type OpenResult } from "./search";

export { searchLocal };

/** Each host is ledgered under its own source's reason. */
const HOSTS: Array<{ test: (h: string) => boolean; source: OpenSourceId; reason: string }> = [
  { test: (h) => h === "knesset.gov.il", source: "knesset", reason: "Knesset records (OData): the law or bill name only" },
  { test: (h) => h === "data.gov.il" || h === "apis.cbs.gov.il", source: "datagov", reason: "Government data (data.gov.il, CBS): the search words or dataset id only" },
];

/** One fetch for a dialog search: asks once; each request goes to the ledger under its source; an off source is never sent to. */
function dialogFetch(confirm: () => Promise<boolean>): typeof fetch {
  const byHost: typeof fetch = (input, init) => {
    const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname;
    const h = HOSTS.find((x) => x.test(host));
    if (!h || !enabledSources()[h.source]) throw new SourceOffError(h?.source ?? host);
    return ledgerFetch({ force: { category: "cloud-text", reason: h.reason }, consent: true })(input, init);
  };
  return gatedFetch({ source: "open", reason: "", confirm, base: byHost });
}

export async function loadLocal(): Promise<Omit<LocalSources, "enabled">> {
  const on = enabledSources();
  const [laws, library] = await Promise.all([
    on.knesset ? import("../knesset/app").then((m) => m.savedLawsInVault()) : Promise.resolve([]),
    on.benyehuda ? import("../benyehuda/app").then((m) => m.library()) : Promise.resolve(null),
  ]);
  return { laws, library };
}

export function searchOnlineGated(q: string, enabled: Record<OpenSourceId, boolean>, kind: Kind | null): Promise<OpenResult[] | null> {
  if (!enabled.knesset && !enabled.datagov) return Promise.resolve([]);
  const confirm = () => uiConfirm({ message: t("openSources.confirm", { query: q }) });
  return (async () => {
    try {
      return await searchOnline(q, enabled, dialogFetch(confirm), kind);
    } catch (e) {
      if (e instanceof Error && e.name === "DeclinedError") return null;
      throw e;
    }
  })();
}

const MAX_COPY = 2000;

/** The Markdown a chosen result becomes, by its rights. */
export async function insertion(r: OpenResult): Promise<string | null> {
  const ask = (what: string) => () => uiConfirm({ message: t("openSources.confirmFetch", { what }) });
  if (r.kind === "verse" && r.payload.ref) {
    const s = await import("../sefaria/app");
    const res = await s.lookup(r.payload.ref, ask(r.payload.ref.tref));
    return res ? s.quoteBlock(res.passage) : null; // each version's own licence decides what is copied
  }
  if (r.kind === "work" && r.payload.work) {
    const b = await import("../benyehuda/app");
    const note = await b.workNote(r.payload.work);
    const { parseWorkNote } = await import("../benyehuda/library");
    const text = note ? (parseWorkNote(note.content)?.text ?? null) : null;
    const cut = text && text.length > MAX_COPY ? text.slice(0, text.lastIndexOf("\n\n", MAX_COPY) > 0 ? text.lastIndexOf("\n\n", MAX_COPY) : MAX_COPY) : text;
    return insertionFor(r, cut);
  }
  if (r.kind === "dataset" && r.payload.dataset) {
    const d = await import("../datagov/app");
    const table = r.payload.dataset.resources.find((x) => x.datastore);
    if (!table) return insertionFor(r, null);
    const res = await d.addResource(r.payload.dataset, table.id, ask(r.title));
    return res?.markdown ?? null;
  }
  if (r.kind === "series" && r.payload.seriesId) {
    const d = await import("../datagov/app");
    const res = await d.addSeries(r.payload.seriesId, ask(r.title));
    return res?.markdown ?? null;
  }
  return insertionFor(r, null);
}


