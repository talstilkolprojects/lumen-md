/**
 * One search over every open source the user turned on (plan W7.24):
 * Sefaria (W5.1), the Knesset (W7.5), data.gov.il and the CBS (W7.6) and
 * the Ben-Yehuda library (W7.7).
 *
 *  - Local first: references are parsed, saved laws and the downloaded
 *    library are searched on the device, as the user types. Nothing is sent.
 *  - Online only on request ("search online"), only for sources that are on
 *    and only after the user confirms; every request goes through the
 *    gated, ledgered fetch.
 *  - Every result carries its rights (sources/open/rights), and the rights
 *    choose what goes into the note: a full copy with its attribution, or a
 *    link only — never a full copy of link-only content.
 */

import { mayCopy, RIGHTS_URL, type Rights } from "./rights";
import type { OpenSourceId } from "./gate";
import { parseSourceRef, type SourceRef } from "../sefaria/refs";
import { matchLaw, searchTermOf } from "../knesset/lawNames";
import { lawCitation, type SavedLaw } from "../knesset/store";
import { recordUrl, searchLaws } from "../knesset/odata";
import { plain, quoteBlock as workQuote, workUrl, type Library, type Work } from "../benyehuda/library";
import { searchDatasets, type DatasetHit } from "../datagov/api";

export type Kind = "verse" | "law" | "work" | "dataset" | "series";

export const KINDS: readonly Kind[] = ["verse", "law", "work", "dataset", "series"];

export interface OpenResult {
  /** Unique within one search. */
  key: string;
  source: OpenSourceId;
  kind: Kind;
  title: string;
  detail: string;
  rights: Rights;
  /** Where the item lives (shown, and the link a link-only insert uses). */
  url: string;
  /** True when the item came from this device (no request was made). */
  local: boolean;
  payload: { ref?: SourceRef; lawId?: number; lawName?: string; savedLaw?: SavedLaw; work?: Work; dataset?: DatasetHit; seriesId?: string };
}

export interface LocalSources {
  enabled: Record<OpenSourceId, boolean>;
  laws: readonly SavedLaw[];
  library: Library | null;
}

/** CBS series Lumen knows by name (the id is what the series API takes). */
export const KNOWN_SERIES: ReadonlyArray<{ id: string; name: string; words: string[] }> = [{ id: "120010", name: "מדד המחירים לצרכן — מדד כללי", words: ["מדד", "המחירים", "לצרכן", "יוקר", "אינפלציה", "cpi"] }];

const normWords = (q: string) => plain(q).toLowerCase().split(/\s+/).filter(Boolean);

/** Results that need no network: a reference, saved laws, the downloaded library, known series. */
export function searchLocal(query: string, src: LocalSources, kind: Kind | null = null): OpenResult[] {
  const q = query.trim();
  if (!q) return [];
  const out: OpenResult[] = [];
  const want = (k: Kind) => !kind || kind === k;
  if (src.enabled.sefaria && want("verse")) {
    const ref = parseSourceRef(q);
    if (ref)
      out.push({
        key: `sefaria:${ref.key}`,
        source: "sefaria",
        kind: "verse",
        title: ref.he,
        detail: ref.tref,
        // Sefaria licenses each version; until the text is fetched the result is treated as link-only, and the
        // insert applies each version's own licence (sources/sefaria/license).
        rights: "link-only",
        url: ref.url,
        local: true,
        payload: { ref },
      });
  }
  if (src.enabled.knesset && want("law") && src.laws.length) {
    const m = matchLaw(
      q,
      src.laws.map((l) => l.law),
    );
    if (m) {
      const saved = src.laws.find((l) => l.law.id === m.law.id)!;
      out.push({ key: `knesset:${m.law.id}`, source: "knesset", kind: "law", title: m.law.name, detail: saved.text ? "סעיף 6" : "", rights: "section-6", url: recordUrl("KNS_IsraelLaw", m.law.id), local: true, payload: { lawId: m.law.id, lawName: m.law.name, savedLaw: saved } });
    }
  }
  if (src.enabled.benyehuda && want("work") && src.library) {
    for (const h of src.library.search(q, 5))
      out.push({ key: `benyehuda:${h.work.id}`, source: "benyehuda", kind: "work", title: plain(h.work.title), detail: h.work.authors, rights: "public-domain", url: workUrl(h.work), local: true, payload: { work: h.work } });
  }
  if (src.enabled.datagov && want("series")) {
    const words = normWords(q);
    for (const s of KNOWN_SERIES) {
      if (words.includes(s.id) || words.filter((w) => s.words.some((x) => x === w || x.startsWith(w))).length >= Math.min(2, words.length))
        out.push({ key: `cbs:${s.id}`, source: "datagov", kind: "series", title: s.name, detail: `CBS ${s.id}`, rights: "cbs-licence", url: `https://apis.cbs.gov.il/series/data/list?id=${s.id}&format=json&download=false`, local: true, payload: { seriesId: s.id } });
    }
  }
  return out;
}

/** Online results, for the sources that are on. `fetchImpl` is the gated fetch. */
export async function searchOnline(query: string, enabled: Record<OpenSourceId, boolean>, fetchImpl: typeof fetch, kind: Kind | null = null): Promise<OpenResult[]> {
  const q = query.trim();
  const out: OpenResult[] = [];
  const jobs: Array<Promise<void>> = [];
  if (enabled.knesset && (!kind || kind === "law")) {
    const term = searchTermOf(q);
    if (term)
    jobs.push(
      searchLaws(term, fetchImpl).then((laws) => {
        const best = matchLaw(q, laws);
        const ordered = best ? [laws.find((l) => l.id === best.law.id)!, ...laws.filter((l) => l.id !== best.law.id)] : laws;
        for (const l of ordered.slice(0, 5)) out.push({ key: `knesset:${l.id}`, source: "knesset", kind: "law", title: l.name, detail: l.validity ?? "", rights: "section-6", url: recordUrl("KNS_IsraelLaw", l.id), local: false, payload: { lawId: l.id, lawName: l.name } });
      }),
    );
  }
  if (enabled.datagov && (!kind || kind === "dataset")) {
    jobs.push(
      searchDatasets(q, fetchImpl).then((hits) => {
        for (const h of hits.slice(0, 5)) out.push({ key: `datagov:${h.name}`, source: "datagov", kind: "dataset", title: h.title, detail: h.organization ?? "", rights: "gov-open", url: `https://data.gov.il/dataset/${encodeURIComponent(h.name)}`, local: false, payload: { dataset: h } });
      }),
    );
  }
  await Promise.all(jobs);
  return out;
}

/** Local and online results together, without duplicates (a saved law beats the same law online). */
export function merge(local: readonly OpenResult[], online: readonly OpenResult[]): OpenResult[] {
  const seen = new Set(local.map((r) => r.key));
  return [...local, ...online.filter((r) => !seen.has(r.key))];
}

/**
 * What a result becomes in a note, by its rights: the content with its
 * attribution when the rights allow a copy, otherwise a link and the
 * attribution. `content` is the text the source gave (null when there is none).
 */
export function insertionFor(r: OpenResult, content: string | null): string {
  if (r.source === "knesset" && r.payload.lawId !== undefined) return lawCitation({ id: r.payload.lawId, name: r.payload.lawName ?? r.title });
  if (mayCopy(r.rights) && content) {
    if (r.kind === "work" && r.payload.work) return workQuote(r.payload.work, content);
    return `${content}\n\n${attributionFor(r)}`;
  }
  return `[${r.title}](${r.url}) — ${attributionFor(r)}`;
}

/** The credit line every insertion carries. */
export function attributionFor(r: OpenResult): string {
  const deed = RIGHTS_URL[r.rights];
  const mark = RIGHTS_LABEL_HE[r.rights];
  const where = { sefaria: "Sefaria", knesset: "הכנסת", datagov: r.kind === "series" ? 'הלמ"ס' : "data.gov.il", benyehuda: "פרויקט בן־יהודה" }[r.source];
  return `מקור: [${where}](${r.url}) · ${deed ? `[${mark}](${deed})` : mark}`;
}

/** The badge text of each right, in Hebrew (the dialog shows the UI language's own, from i18n). */
export const RIGHTS_LABEL_HE: Record<Rights, string> = {
  "public-domain": "רשות הציבור",
  cc0: "CC0",
  "cc-by": "CC BY",
  "cc-by-sa": "CC BY-SA",
  "section-6": "סעיף 6 (חקיקה ודברי הכנסת)",
  "cbs-licence": 'רישיון הלמ"ס',
  "gov-open": "data.gov.il",
  "link-only": "קישור בלבד",
};
