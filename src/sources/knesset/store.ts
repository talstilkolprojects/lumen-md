/**
 * Laws and bills in the vault (plan W7.5).
 *
 *  - A saved law is a note in `Sources/Knesset/Laws/`, written only when the
 *    user asks. Its frontmatter carries the source, the record link, the
 *    date it was retrieved and its rights (`section-6`: Copyright Act 2007
 *    §6 — no copyright in laws or Knesset records — so a full copy is
 *    allowed). Its body holds the law's text under "## נוסח" when the user
 *    added it; attachments (opinions, presentations) are kept as links only.
 *  - A lookup reads the saved laws first: a law that was saved opens with no
 *    request at all.
 *  - "Ask the law" searches the sections of saved laws locally (BM25 with
 *    Hebrew morphology), and every answer is a verbatim section that
 *    `verifyVaultCitations` checks against the saved note.
 */

import { Bm25Index } from "../../search/bm25";
import { verifyVaultCitations } from "../../ai/vaultCitations";
import type { Rights } from "../open/rights";
import { lawKey, matchLaw, searchTermOf, type LawRecord } from "./lawNames";
import { recordUrl, searchLaws, type Bill, type Law } from "./odata";

export const LAWS_DIR = "Sources/Knesset/Laws";
export const BILLS_DIR = "Sources/Knesset/Bills";
export const LAW_RIGHTS: Rights = "section-6";

export interface NoteStorage {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** Paths under a folder. */
  list(dir: string): Promise<string[]>;
}

const yaml = (s: string) => JSON.stringify(s);
const fileName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

export const lawNotePath = (law: Pick<Law, "name">) => `${LAWS_DIR}/${fileName(law.name)}.md`;
export const billNotePath = (bill: Pick<Bill, "id" | "name">) => `${BILLS_DIR}/${bill.id} ${fileName(bill.name)}.md`;

/** The saved copy of a law: metadata in the frontmatter, the text (if any) under "## נוסח". */
export function renderLawNote(law: Law, retrieved: string, text = ""): string {
  const fm = [
    "---",
    "type: source",
    "source: knesset",
    "kind: law",
    `id: ${law.id}`,
    `name: ${yaml(law.name)}`,
    `url: ${recordUrl("KNS_IsraelLaw", law.id)}`,
    `retrieved: ${retrieved}`,
    `rights: ${LAW_RIGHTS}`,
    `basicLaw: ${law.isBasicLaw === true}`,
    ...(law.publicationDate ? [`published: ${law.publicationDate}`] : []),
    ...(law.latestPublicationDate ? [`latestPublication: ${law.latestPublicationDate}`] : []),
    ...(law.validity ? [`validity: ${yaml(law.validity)}`] : []),
    ...(law.knessetNum ? [`knesset: ${law.knessetNum}`] : []),
    "---",
    "",
  ];
  return [...fm, `# ${law.name}`, "", "## נוסח", "", text.trim(), ""].join("\n");
}

export function renderBillNote(bill: Bill, retrieved: string): string {
  return [
    "---",
    "type: source",
    "source: knesset",
    "kind: bill",
    `id: ${bill.id}`,
    `name: ${yaml(bill.name)}`,
    `url: ${recordUrl("KNS_Bill", bill.id)}`,
    `retrieved: ${retrieved}`,
    `rights: ${LAW_RIGHTS}`,
    ...(bill.knessetNum ? [`knesset: ${bill.knessetNum}`] : []),
    ...(bill.subType ? [`billType: ${yaml(bill.subType)}`] : []),
    ...(bill.publicationDate ? [`published: ${bill.publicationDate}`] : []),
    "---",
    "",
    `# ${bill.name}`,
    "",
    ...(bill.summary ? ["## תקציר", "", bill.summary.trim(), ""] : []),
  ].join("\n");
}

export interface SavedLaw {
  path: string;
  law: LawRecord & { url: string; retrieved: string; rights: string };
  /** The text under "## נוסח" ("" when none was added). */
  text: string;
  content: string;
}

/** A saved law note back as data; null for anything else. */
export function parseLawNote(path: string, md: string): SavedLaw | null {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m || !/^source: knesset$/m.test(m[1]) || !/^kind: law$/m.test(m[1])) return null;
  const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(m[1])?.[1];
  const id = Number(field("id"));
  const rawName = field("name");
  if (!Number.isFinite(id) || !rawName) return null;
  const name = rawName.startsWith('"') ? (JSON.parse(rawName) as string) : rawName;
  const body = m[2];
  const at = body.indexOf("\n## נוסח");
  const text = at < 0 ? "" : body.slice(at + "\n## נוסח".length).replace(/^\s*\n/, "").split(/\n## /)[0].trim();
  return {
    path,
    law: { id, name, isBasicLaw: field("basicLaw") === "true", url: field("url") ?? recordUrl("KNS_IsraelLaw", id), retrieved: field("retrieved") ?? "", rights: field("rights") ?? "" },
    text,
    content: md,
  };
}

export async function savedLaws(storage: NoteStorage): Promise<SavedLaw[]> {
  const out: SavedLaw[] = [];
  for (const p of await storage.list(LAWS_DIR)) {
    if (!p.endsWith(".md")) continue;
    const md = await storage.read(p);
    const s = md ? parseLawNote(p, md) : null;
    if (s) out.push(s);
  }
  return out;
}

export interface LawLookup {
  /** The saved note, when the law came from the vault. */
  saved: SavedLaw | null;
  law: Law | null;
  from: "vault" | "network";
  /** Other candidates from the Knesset, best first (for a choice). */
  candidates: Law[];
}

/**
 * The law a name refers to: the saved copy first (no request), otherwise the
 * Knesset's records for the name's longest word. null when nothing matches.
 */
export async function lookupLaw(name: string, deps: { storage: NoteStorage; fetch: typeof fetch }): Promise<LawLookup | null> {
  const saved = await savedLaws(deps.storage);
  const local = matchLaw(
    name,
    saved.map((s) => s.law),
  );
  if (local && local.score >= 0.9) {
    const hit = saved.find((s) => s.law.id === local.law.id) ?? null;
    return { saved: hit, law: null, from: "vault", candidates: [] };
  }
  const term = searchTermOf(name);
  if (!term) return null;
  const laws = await searchLaws(term, deps.fetch);
  const best = matchLaw(name, laws);
  if (!best) return laws.length ? { saved: null, law: null, from: "network", candidates: laws.slice(0, 10) } : null;
  const law = laws.find((l) => l.id === best.law.id) ?? null;
  const key = lawKey(name);
  const others = laws.filter((l) => l.id !== best.law.id && lawKey(l.name).includes(key.replace(/^basic:/, "")));
  return { saved: null, law, from: "network", candidates: others.slice(0, 9) };
}

export async function saveLaw(law: Law, storage: NoteStorage, text = "", today = new Date().toISOString().slice(0, 10)): Promise<string> {
  const path = lawNotePath(law);
  await storage.write(path, renderLawNote(law, today, text));
  return path;
}

export async function saveBill(bill: Bill, storage: NoteStorage, today = new Date().toISOString().slice(0, 10)): Promise<string> {
  const path = billNotePath(bill);
  await storage.write(path, renderBillNote(bill, today));
  return path;
}

/** A law citation for a note: the name as a wiki link to the saved copy, the record link, and the rights. */
export function lawCitation(law: { name: string; id: number }, section?: string): string {
  const title = section ? `סעיף ${section} ל${law.name}` : law.name;
  return `[[${fileName(law.name)}|${title}]] — [מקור: הכנסת](${recordUrl("KNS_IsraelLaw", law.id)}) · סעיף 6 לחוק זכות יוצרים`;
}

// ── Sections and "Ask the law" ───────────────────────────────────────────

export interface Section {
  /** "7", "1א", "6" */
  number: string;
  text: string;
}

/** Sections of a law's text: a line that starts with "7." / "1א." / "סעיף 7" opens one. */
export function lawSections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:סעיף\s+)?(\d{1,3}[א-ת]?)\.\s+(.*)$/.exec(line) ?? /^#{1,4}\s*סעיף\s+(\d{1,3}[א-ת]?)\s*[:.-]?\s*(.*)$/.exec(line);
    if (m) {
      cur = { number: m[1], text: m[2] };
      out.push(cur);
    } else if (cur) cur.text += ` ${line}`;
  }
  return out;
}

export interface LawAnswer {
  law: SavedLaw;
  section: Section;
  score: number;
  /** The answer as written into a note: the section, quoted, with its citation. */
  markdown: string;
  /** The quote was found word for word in the saved law (the citation check). */
  verified: boolean;
}

/** Search the saved laws' sections for a question; the best sections, each verified against its note. */
export function askTheLaw(question: string, laws: readonly SavedLaw[], limit = 3): LawAnswer[] {
  const index = new Bm25Index();
  const where = new Map<string, { law: SavedLaw; section: Section }>();
  for (const law of laws) {
    for (const s of lawSections(law.text)) {
      const id = `${law.path}#${s.number}`;
      where.set(id, { law, section: s });
      index.set(id, s.text, law.law.name);
    }
  }
  return index.search(question, { limit }).map((hit) => {
    const { law, section } = where.get(hit.id)!;
    // The citation check reads a quote up to its first double quote (and at most 300 characters).
    const plain = section.text.split(/["“”«»]/)[0];
    const quote = plain.length > 280 ? plain.slice(0, 280).replace(/\s+\S*$/, "") : plain;
    const answer = `[1] "${quote}"`;
    const verified = verifyVaultCitations(answer, [{ path: law.path, content: law.content }]).verifiedCount === 1;
    const markdown = [`> ${section.number}. ${quote}`, ">", `> — ${lawCitation(law.law, section.number)}`].join("\n");
    return { law, section, score: hit.score, markdown, verified };
  });
}
