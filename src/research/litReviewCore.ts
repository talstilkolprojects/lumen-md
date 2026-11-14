/**
 * Plan W5.12 — a literature-review matrix from the PDFs in the vault, on
 * this device. For each paper and each field (question, method, sample,
 * findings, limitations), the passages retrieval finds go to a local model,
 * which answers with quotes copied from them. A value is kept only with at
 * least one quote verified in its passage and located on its page: the
 * matrix never holds a value without a citation.
 *
 * The pure parts (no app imports): the fields, verification, the note per
 * paper and the `.base` file that shows them as a table (Obsidian Bases
 * syntax, W1.11). The app glue is ./litReview.ts.
 */
import { locateQuote, type PdfChunk } from "../pdf/pdfChatCore";

export interface LitField {
  key: "question" | "method" | "sample" | "findings" | "limitations";
  /** Retrieval query, English and Hebrew words (papers in either). */
  query: string;
  /** What the model is asked to extract. */
  ask: string;
  label: string;
}

export const FIELDS: readonly LitField[] = [
  { key: "question", label: "Question", query: "research question aim objective we investigate whether hypothesis purpose of this study שאלת המחקר מטרת המחקר השערה", ask: "the research question or aim of the study" },
  { key: "method", label: "Method", query: "method design randomized trial survey experiment we used analysis procedure שיטה מערך המחקר ניסוי סקר ניתוח", ask: "the study design and method" },
  { key: "sample", label: "Sample", query: "participants sample n = subjects recruited dataset cohort respondents משתתפים מדגם נבדקים", ask: "the sample: who or what was studied, and how many" },
  { key: "findings", label: "Findings", query: "results findings we found showed significant effect increased reduced associated ממצאים תוצאות נמצא", ask: "the main findings" },
  { key: "limitations", label: "Limitations", query: "limitations limitation however caution future research cannot generalize מגבלות מגבלה מחקר עתידי", ask: "the limitations the authors state" },
];

/** What the model answers for one field. */
export interface FieldOut {
  value: string;
  citations: Array<{ source: number; quote: string }>;
}

export interface FieldCitation {
  quote: string;
  page: number;
  line: number;
}

export interface FieldResult {
  key: LitField["key"];
  /** null when no quote could be verified: the value is not kept. */
  value: string | null;
  citations: FieldCitation[];
  /** Quotes the model gave that are not in the passage they name (not kept). */
  dropped: number;
}

const squash = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** Keep the citations whose quote is in its passage, located on page and line; drop the value if none is left. */
export function verifyField(key: LitField["key"], out: FieldOut, chunks: readonly PdfChunk[]): FieldResult {
  const citations: FieldCitation[] = [];
  let dropped = 0;
  for (const c of out.citations ?? []) {
    const chunk = chunks[c.source - 1];
    const at = chunk && typeof c.quote === "string" && squash(c.quote).length >= 8 ? locateQuote(c.quote, chunk) : null;
    if (!at) {
      dropped++;
      continue;
    }
    if (!citations.some((x) => x.page === at.page && x.line === at.line)) citations.push({ quote: c.quote.trim(), page: at.page, line: at.line });
  }
  const value = (out.value ?? "").trim();
  return { key, value: value && citations.length ? value : null, citations: value ? citations : [], dropped };
}

export interface PaperResult {
  /** Vault path of the PDF. */
  pdf: string;
  title: string;
  fields: FieldResult[];
}

/** Extract every field of one paper: `retrieve(query)` gives the passages, `ask(field, passages)` the model's answer. */
export async function extractPaper(pdf: string, title: string, retrieve: (query: string) => Promise<PdfChunk[]>, ask: (field: LitField, chunks: PdfChunk[]) => Promise<FieldOut>, fields: readonly LitField[] = FIELDS): Promise<PaperResult> {
  const out: FieldResult[] = [];
  for (const f of fields) {
    const chunks = await retrieve(f.query);
    let res: FieldOut;
    try {
      res = await ask(f, chunks);
    } catch {
      res = { value: "", citations: [] };
    }
    out.push(verifyField(f.key, res, chunks));
  }
  return { pdf, title, fields: out };
}

/** YAML double-quoted scalar. */
const q = (s: string) => JSON.stringify(s);
const fileName = (p: string) => p.split("/").pop() ?? p;

/** The note for one paper: frontmatter properties for the table, and every value with its quotes and page links. */
export interface NoteWords {
  /** Heading per field key. */
  labels: Record<LitField["key"], string>;
  source: string;
  noValue: string;
  page: (page: number, line: number) => string;
}

const ENGLISH: NoteWords = {
  labels: Object.fromEntries(FIELDS.map((f) => [f.key, f.label])) as Record<LitField["key"], string>,
  source: "Source",
  noValue: "No value with a verified quote.",
  page: (page, line) => `p. ${page}, line ${line}`,
};

export function paperNote(p: PaperResult, { date = new Date(), words = ENGLISH }: { date?: Date; words?: NoteWords } = {}): string {
  const verified = p.fields.filter((f) => f.value).length;
  const fm = [
    "---",
    `lit-pdf: ${q(`[[${p.pdf}]]`)}`,
    ...p.fields.map((f) => `lit-${f.key}: ${f.value ? q(f.value) : "null"}`),
    `lit-verified: ${verified}`,
    `lit-complete: ${verified === p.fields.length}`,
    `lit-extracted: ${date.toISOString().slice(0, 10)}`,
    "tags: [literature-review]",
    "---",
    "",
    `# ${p.title}`,
    "",
    `${words.source}: [[${p.pdf}|${fileName(p.pdf)}]]`,
    "",
  ];
  for (const f of p.fields) {
    fm.push(`## ${words.labels[f.key]}`, "");
    if (!f.value) {
      fm.push(`_${words.noValue}_`, "");
      continue;
    }
    fm.push(f.value, "");
    for (const c of f.citations) fm.push(`> “${c.quote}” — [[${p.pdf}#page=${c.page}|${words.page(c.page, c.line)}]]`, "");
  }
  return fm.join("\n");
}

/** The `.base` that shows the papers as a matrix, with a view of the papers whose every field is verified. */
export function reviewBase(folder: string, words: Pick<NoteWords, "labels"> & { verified: string; all: string; verifiedOnly: string } = { labels: ENGLISH.labels, verified: "Verified fields", all: "All papers", verifiedOnly: "Verified only" }): string {
  const cols = FIELDS.map((f) => `note.lit-${f.key}`);
  return [
    "# Literature review (plan W5.12): one row per paper, one column per field.",
    "# Every value in these notes has a quote verified on its page.",
    "filters:",
    "  and:",
    `    - file.inFolder(${q(folder)})`,
    '    - file.hasTag("literature-review")',
    "properties:",
    ...FIELDS.flatMap((f) => [`  note.lit-${f.key}:`, `    displayName: ${q(words.labels[f.key])}`]),
    "  note.lit-verified:",
    `    displayName: ${q(words.verified)}`,
    "views:",
    "  - type: table",
    `    name: ${q(words.all)}`,
    `    order: [file.name, ${cols.join(", ")}, note.lit-verified]`,
    "  - type: table",
    `    name: ${q(words.verifiedOnly)}`,
    "    filters:",
    "      and:",
    "        - note.lit-complete == true",
    `    order: [file.name, ${cols.join(", ")}]`,
    "",
  ].join("\n");
}

/** A safe note name for a paper title. */
export function noteName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Paper";
}
