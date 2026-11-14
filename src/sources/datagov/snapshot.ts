/**
 * The ```dataset block and its local snapshot (plan W7.6).
 *
 *     ```dataset
 *     source: datagov            (or: cbs)
 *     id: <resource id | series id>
 *     title: "אוכלוסייה ביישובים"
 *     snapshot: Data/datagov/<id>/2026-11-14.csv
 *     retrieved: 2026-11-14
 *     view: table                (or: chart)
 *     ```
 *     מקור: …the attribution line…
 *
 *  - The rows are fetched once, when the user asks, and saved as CSV in the
 *    vault. The note shows the table or chart from that file: opening the
 *    note offline makes no request.
 *  - The attribution is written as an ordinary line under the block, so a
 *    PDF or DOCX export carries it with no special handling. Its wording
 *    follows the CBS licence (version 2.1): product name, retrieval date,
 *    a link to the data, "as is", and a link to the terms; and for
 *    data.gov.il, its FAQ: the site, the dataset and its update date.
 *  - Refresh fetches again and shows what changed against the old snapshot.
 *  - A dataset whose columns look personal gets a warning: the CBS licence
 *    forbids cross-matching data to identify people.
 */

import { seriesUrl, type Table } from "./api";

export type DataSource = "datagov" | "cbs";

export interface DatasetBlock {
  source: DataSource;
  id: string;
  title: string;
  snapshot: string;
  retrieved: string;
  view: "table" | "chart";
  /** data.gov.il: the publisher and the dataset's update date. */
  organization?: string | null;
  updated?: string | null;
  /** data.gov.il: the dataset's page slug. */
  dataset?: string | null;
  /** SHA-256 of the snapshot file, hex: the block shows only the file it wrote (review 20, RR20-4). */
  sha256?: string | null;
}

export const CBS_TERMS = "https://www.cbs.gov.il/he/Pages/%D7%A8%D7%99%D7%A9%D7%99%D7%95%D7%9F-%D7%A9%D7%99%D7%9E%D7%95%D7%A9.aspx";

// ── CSV ─────────────────────────────────────────────────────────────────

const cell = (v: string | number | null) => {
  const t = v === null ? "" : String(v);
  return /[",\n\r]/.test(t) || /^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function toCsv(t: Table): string {
  const head = t.fields.map((f) => cell(f.id)).join(",");
  return [head, ...t.rows.map((r) => t.fields.map((f) => cell(r[f.id] ?? null)).join(","))].join("\n") + "\n";
}

/** RFC 4180 CSV back into rows of strings (the first row is the header). */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    out.push(row);
  }
  const [header = [], ...rows] = out;
  return { header, rows };
}

// ── The block ───────────────────────────────────────────────────────────

/** JSON-quoted, with backticks escaped too, so no value can look like a fence. */
const q = (v: string) => JSON.stringify(v).replace(/`/g, "\\u0060");

export function renderBlock(b: DatasetBlock): string {
  // Every value is JSON-quoted (review 20, RR20-3): a remote field with a line break or a fence stays one value.
  const lines = [
    "```dataset",
    `source: ${b.source}`,
    `id: ${q(b.id)}`,
    `title: ${q(b.title)}`,
    ...(b.dataset ? [`dataset: ${q(b.dataset)}`] : []),
    ...(b.organization ? [`organization: ${q(b.organization)}`] : []),
    ...(b.updated ? [`updated: ${q(b.updated)}`] : []),
    `snapshot: ${q(b.snapshot)}`,
    `retrieved: ${q(b.retrieved)}`,
    ...(b.sha256 ? [`sha256: ${b.sha256}`] : []),
    `view: ${b.view}`,
    "```",
  ];
  return lines.join("\n");
}

export function parseBlock(body: string): DatasetBlock | null {
  const f: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    try {
      f[m[1]] = m[2].startsWith('"') ? (JSON.parse(m[2]) as string) : m[2];
    } catch {
      return null;
    }
  }
  if ((f.source !== "datagov" && f.source !== "cbs") || !f.id || !f.snapshot) return null;
  // Only a file this block could have written (review 20, RR20-4): Data/<source>/<its id>/<date>.csv.
  // A block in a shared note can't point the reader's preview at another file of their vault.
  const date = /^Data\/(datagov|cbs)\/([\w.-]+)\/(\d{4}-\d\d-\d\d)\.csv$/.exec(f.snapshot);
  if (!date || date[1] !== f.source || f.snapshot !== snapshotPath(f.source, f.id, date[3])) return null;
  return {
    source: f.source,
    id: f.id,
    title: f.title ?? f.id,
    snapshot: f.snapshot,
    retrieved: f.retrieved ?? "",
    view: f.view === "chart" ? "chart" : "table",
    organization: f.organization ?? null,
    updated: f.updated ?? null,
    dataset: f.dataset ?? null,
    sha256: /^[0-9a-f]{64}$/.test(f.sha256 ?? "") ? f.sha256 : null,
  };
}

export const snapshotPath = (source: DataSource, id: string, retrieved: string) => `Data/${source}/${id.replace(/[^\w.-]/g, "_")}/${retrieved}.csv`;

/** The link to the data itself. */
export function dataUrl(b: Pick<DatasetBlock, "source" | "id" | "dataset">): string {
  if (b.source === "cbs") return seriesUrl(b.id);
  return b.dataset ? `https://data.gov.il/dataset/${encodeURIComponent(b.dataset)}/resource/${encodeURIComponent(b.id)}` : `https://data.gov.il/api/3/action/datastore_search?resource_id=${encodeURIComponent(b.id)}`;
}

const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? `${d}.${m}.${y}` : iso;
};

/**
 * The attribution line. CBS (licence 2.1): "הלשכה המרכזית לסטטיסטיקה (הלמ"ס),
 * [product], ([retrieval date]), ניתן לצפייה באתר: [link] מועתק ומופץ כמות שהוא
 * – as is – על פי רישיון שימוש של הלמ"ס בכתובת אתר האינטרנט [terms]."
 * data.gov.il: the site, the dataset (and publisher), its update date, the
 * retrieval date and the link.
 */
/**
 * Remote text as plain Markdown text on one line (review 25, RR25-3): no line breaks, and every
 * character Markdown or HTML gives a meaning (headings, links, emphasis, `<!--`, tags) backslash-escaped.
 */
export function mdText(s: string): string {
  return s
    .replace(/[\r\n\u2028\u2029\t]+/g, " ")
    .replace(/[\\`*_[\]()#<>!|~{}&+=-]/g, "\\$&")
    .trim();
}

export function attribution(b: DatasetBlock): string {
  const url = dataUrl(b);
  if (b.source === "cbs") {
    return `הלשכה המרכזית לסטטיסטיקה (הלמ"ס), ${mdText(b.title)}, (${dmy(b.retrieved)}), ניתן לצפייה באתר: ${url} מועתק ומופץ כמות שהוא – as is – על פי רישיון שימוש של הלמ"ס בכתובת אתר האינטרנט ${CBS_TERMS}.`;
  }
  const org = b.organization ? ` (${mdText(b.organization)})` : "";
  const upd = b.updated ? `, עודכן ${dmy(b.updated)}` : "";
  return `מקור: data.gov.il – אתר המידע הממשלתי, מאגר "${mdText(b.title)}"${org}${upd}, נשלף ${dmy(b.retrieved)}, ${url}`;
}

/** What goes into the note: the block and, under it, the attribution line. */
export function insertion(b: DatasetBlock): string {
  return `${renderBlock(b)}\n\n${attribution(b)}\n`;
}

/** SHA-256 of a text, hex. */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The snapshot's text when it is the file the block recorded (path rule and hash); null otherwise. */
export async function verifiedSnapshot(b: DatasetBlock, read: (path: string) => Promise<string | null>): Promise<string | null> {
  if (!b.sha256) return null;
  const text = await read(b.snapshot);
  return text !== null && (await sha256Hex(text)) === b.sha256 ? text : null;
}

// ── Refresh: what changed ───────────────────────────────────────────────

export interface SnapshotDiff {
  added: string[][];
  removed: string[][];
  /** Same key (the first column), different values. */
  changed: Array<{ key: string; before: string[]; after: string[] }>;
  columnsChanged: boolean;
}

export function diffSnapshots(oldCsv: string, newCsv: string): SnapshotDiff {
  const a = parseCsv(oldCsv);
  const b = parseCsv(newCsv);
  const columnsChanged = a.header.join("\u0000") !== b.header.join("\u0000");
  const keyOf = (r: string[]) => r[0] ?? "";
  const unique = (rows: string[][]) => new Set(rows.map(keyOf)).size === rows.length;
  if (!columnsChanged && unique(a.rows) && unique(b.rows)) {
    const before = new Map(a.rows.map((r) => [keyOf(r), r]));
    const after = new Map(b.rows.map((r) => [keyOf(r), r]));
    const changed: SnapshotDiff["changed"] = [];
    for (const [k, r] of after) {
      const old = before.get(k);
      if (old && old.join("\u0000") !== r.join("\u0000")) changed.push({ key: k, before: old, after: r });
    }
    return { added: b.rows.filter((r) => !before.has(keyOf(r))), removed: a.rows.filter((r) => !after.has(keyOf(r))), changed, columnsChanged };
  }
  // No usable key: compare whole rows as a multiset.
  const count = new Map<string, number>();
  for (const r of a.rows) count.set(r.join("\u0000"), (count.get(r.join("\u0000")) ?? 0) + 1);
  const added: string[][] = [];
  for (const r of b.rows) {
    const k = r.join("\u0000");
    const n = count.get(k) ?? 0;
    if (n) count.set(k, n - 1);
    else added.push(r);
  }
  const removed = [...count].flatMap(([k, n]) => Array.from({ length: n }, () => k.split("\u0000")));
  return { added, removed, changed: [], columnsChanged };
}

/** A short Markdown summary of a refresh, for a dialog or a note. */
export function diffSummary(d: SnapshotDiff, header: string[]): string {
  const row = (r: string[]) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  const out: string[] = [];
  if (d.columnsChanged) out.push("**columns changed**");
  const head = [row(header), row(header.map(() => "---"))];
  if (d.added.length) out.push(`**+${d.added.length}**`, ...head, ...d.added.slice(0, 20).map(row));
  if (d.removed.length) out.push(`**−${d.removed.length}**`, ...head, ...d.removed.slice(0, 20).map(row));
  if (d.changed.length) out.push(`**~${d.changed.length}**`, ...d.changed.slice(0, 20).map((c) => `- ${c.key}: ${c.before.join(", ")} → ${c.after.join(", ")}`));
  return out.join("\n");
}

// ── Personal-looking columns ────────────────────────────────────────────

const PERSONAL = /(^|[\s_])(שם|שם_פרטי|שם_משפחה|ת\.?ז|תעודת[\s_]זהות|מספר[\s_]זהות|טלפון|נייד|כתובת|דוא"?ל|מייל|תאריך[\s_]לידה|לוחית|מספר[\s_]רכב|name|first_?name|last_?name|surname|id_?number|teudat|phone|mobile|address|email|e-mail|birth|dob|license_?plate|mispar_?rechev)($|[\s_])/i;

/** Columns that look like personal data (names, ids, phones, addresses, birth dates). */
const PLACE = /(ישוב|יישוב|רחוב|עיר|מוסד|רשות|מחוז|נפה|מקום|יצרן|דגם|תוצר|settlement|city|street|locality|place|district|model|product)/i;

export function personalColumns(columns: readonly string[]): string[] {
  return columns.filter((c) => PERSONAL.test(c.trim()) && !PLACE.test(c));
}
