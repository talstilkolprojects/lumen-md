/**
 * Knesset committee protocols as text (plan W7.5): who spoke, what they
 * said, and on which page — so a quote can carry the speaker, the session
 * date and the page number.
 *
 * Protocols are published as DOC/PDF in KNS_DocumentCommitteeSession. Their
 * text (opened in Lumen, or extracted from the document) marks speakers in
 * two ways, and both are read here:
 *
 *   - newer protocols: `<< דובר >> שם הדובר: << דובר >>` (also `<< יור >>`,
 *     `<< אורח >>`, `<< קריאה >>`);
 *   - older ones: a short line that ends with a colon (`היו״ר שמחה רוטמן:`).
 *
 * Pages: a form feed (\f) starts a new page, and so does a line that holds
 * only a page number when it follows the previous page's number.
 */

export interface Turn {
  speaker: string;
  /** The words, paragraphs joined by "\n". */
  text: string;
  /** 1-based page where the turn starts. */
  page: number;
}

const MARKED = /^<<\s*(?:דובר|יור|אורח|קריאה|דובר_המשך)\s*>>\s*(.+?)\s*:?\s*<<\s*(?:דובר|יור|אורח|קריאה|דובר_המשך)\s*>>\s*$/;
const COLON = /^([^\s:][^:]{1,60}):\s*$/;

/** Speaker lines that are headings, not people. */
const NOT_A_SPEAKER = /^(?:סדר היום|נכחו|חברי הוועדה|מוזמנים|ייעוץ משפטי|מנהל[\/ ]ת? הוועדה|רישום פרלמנטרי|קצרנית|הישיבה ננעלה|חברי הכנסת|נושא)/;

export function parseProtocol(text: string): Turn[] {
  const turns: Turn[] = [];
  let page = 1;
  let lastNumber = 0;
  let cur: Turn | null = null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const ffs = (raw.match(/\f/g) ?? []).length;
    page += ffs;
    const line = raw.replace(/\f/g, "").trim();
    if (!line) continue;
    if (/^-?\s*\d{1,4}\s*-?$/.test(line)) {
      const n = Number(line.replace(/\D/g, ""));
      if (n === lastNumber + 1 || (lastNumber === 0 && n === page)) {
        lastNumber = n;
        if (!ffs) page = n + 1;
        continue;
      }
    }
    const marked = MARKED.exec(line);
    const colon = marked ? null : COLON.exec(line);
    const speaker = (marked?.[1] ?? colon?.[1])?.trim();
    if (speaker && !NOT_A_SPEAKER.test(speaker) && speaker.split(/\s+/).length <= 7) {
      cur = { speaker, text: "", page };
      turns.push(cur);
      continue;
    }
    if (cur) cur.text = cur.text ? `${cur.text}\n${line}` : line;
  }
  return turns.filter((t) => t.text);
}

export interface ProtocolMeta {
  committee: string;
  sessionNumber: number | null;
  knessetNum: number | null;
  /** YYYY-MM-DD */
  date: string | null;
  url: string | null;
}

/**
 * The reference for a protocol page, after the Israeli Uniform Citation
 * Rules (כללי האזכור האחיד, the form for Knesset committee protocols):
 * "פרוטוקול ישיבה מס' 12 של ועדת החוקה, חוק ומשפט, הכנסת ה-25, 7 (3.1.2023)".
 * W5.2 owns the full rule set; when it lands, its formatter replaces this one.
 */
export function citeProtocol(meta: ProtocolMeta, page?: number): string {
  const parts = [`פרוטוקול ישיבה${meta.sessionNumber ? ` מס' ${meta.sessionNumber}` : ""} של ${meta.committee}`];
  if (meta.knessetNum) parts.push(`הכנסת ה-${meta.knessetNum}`);
  let tail = page ? String(page) : "";
  if (meta.date) {
    const [y, m, d] = meta.date.split("-").map(Number);
    tail = `${tail}${tail ? " " : ""}(${d}.${m}.${y})`;
  }
  return parts.join(", ") + (tail ? `, ${tail}` : "");
}

/** The turn that holds `excerpt` (spaces and niqqud aside), or null. */
export function findTurn(turns: readonly Turn[], excerpt: string): Turn | null {
  const norm = (s: string) => s.replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim();
  const want = norm(excerpt);
  if (!want) return null;
  return turns.find((t) => norm(t.text).includes(want)) ?? null;
}

/** A protocol quote for a note: the words, the speaker, and the citation with the page. */
export function protocolQuote(turn: Turn, excerpt: string, meta: ProtocolMeta): string {
  const words = excerpt.trim().split("\n").map((l) => `> ${l}`);
  const link = meta.url ? ` · [${"פרוטוקול"}](${meta.url})` : "";
  return [...words, ">", `> — ${turn.speaker}, ${citeProtocol(meta, turn.page)}${link}`].join("\n");
}

const MONTHS: Record<string, number> = { ינואר: 1, פברואר: 2, מרץ: 3, מרס: 3, אפריל: 4, מאי: 5, יוני: 6, יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12 };
const UNITS: Record<string, number> = { אחת: 1, אחד: 1, שתיים: 2, שניים: 2, שתים: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9 };
const TENS: Record<string, number> = { עשרים: 20, שלושים: 30 };

/** "הכנסת העשרים וחמש" → 25, "הכנסת השש עשרה" → 16, "הכנסת ה-24" → 24. */
export function knessetNumber(text: string): number | null {
  const digits = /הכנסת\s+ה-?(\d{1,2})\b/.exec(text);
  if (digits) return Number(digits[1]);
  const m = /הכנסת\s+ה([א-ת]+)(?:\s+ו?([א-ת]+))?(?:\s+(עשרה|עשר))?/.exec(text);
  if (!m) return null;
  const a = m[1];
  const b = m[2];
  if (TENS[a]) return TENS[a] + (b ? (UNITS[b] ?? 0) : 0);
  if (UNITS[a] && (b === "עשרה" || b === "עשר" || m[3])) return 10 + UNITS[a];
  return null;
}

/** The session's details from the protocol's own first lines: number, committee, Knesset, date. Nothing is fetched. */
export function parseProtocolHeader(text: string): ProtocolMeta {
  const head = text.slice(0, 2000).replace(/[״“”]/g, '"');
  const num = /פרוטוקול\s+מס['׳]?\s*(\d+)/.exec(head);
  const committee = /מישיבת\s+(ה?ועד[הת][^\n,]*(?:,[^\n,]*(?:ו?משפט|ו?חקיקה)[^\n,]*)?)/.exec(head);
  const date = /\((\d{1,2})\s+ב([א-ת]+)\s+(\d{4})\)/.exec(head);
  const month = date ? MONTHS[date[2]] : undefined;
  return {
    committee: committee ? committee[1].trim() : "",
    sessionNumber: num ? Number(num[1]) : null,
    knessetNum: knessetNumber(head),
    date: date && month ? `${date[3]}-${String(month).padStart(2, "0")}-${date[1].padStart(2, "0")}` : null,
    url: null,
  };
}
