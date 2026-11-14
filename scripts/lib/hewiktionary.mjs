/**
 * Hebrew Wiktionary → Lumen's offline Hebrew lexicon (plan W5.26): the pure
 * part of scripts/build-hebrew-lexicon.mjs, tested with fixtures in
 * src/__tests__/hebrewLexicon.test.ts.
 *
 * A he.wiktionary page is one unpointed title (בית) with one section per
 * homograph, headed by its pointed form:
 *
 *     == בַּיִת ==
 *     {{ניתוח דקדוקי
 *     |חלק דיבר=שם־עצם
 *     ...}}
 *     # [[מבנה]] המשמש ל[[מגורים]].
 *     #: {{דוגמה|...}}
 *     ===נרדפות===
 *     * [[דירה]], [[מעון]]
 *
 * Kept per homograph: the pointed headword, the part of speech, up to
 * MAX_DEFS definitions (examples and quotes dropped) and the synonyms of the
 * נרדפות section. The text is CC BY-SA 4.0 (Wikimedia's terms since 2023);
 * the pack says so and names its source dump.
 */

export const PACK_FORMAT = "lumen-lexicon/1";
export const MAX_DEFS = 4;
export const MAX_DEF_CHARS = 280;

const HEBREW_WORD = /^[\u05D0-\u05EA][\u05D0-\u05EA\u05B0-\u05C7'"׳״\-־ ]*$/;
const SYN_HEADING = /^(?:מילים\s+)?נרדפות$/;

/** Wiki markup to plain text: links, bold / italic, references, HTML and templates out. */
export function plainText(s) {
  let t = s;
  t = t.replace(/<ref[^>]*\/>/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "");
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  // Templates: nested ones too, innermost first.
  for (let i = 0; i < 5 && /\{\{[^{}]*\}\}/.test(t); i++) t = t.replace(/\{\{[^{}]*\}\}/g, "");
  t = t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1");
  t = t.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1").replace(/\[https?:\/\/\S+\]/g, "");
  t = t.replace(/'''?/g, "").replace(/<[^>]+>/g, "");
  return t.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
}

/** The value of `|key=` in the grammar box. */
function boxField(box, key) {
  const m = new RegExp(`\\|\\s*${key}\\s*=([^|\\n}]*)`).exec(box);
  return m ? plainText(m[1]) : "";
}

/** Link targets of a line: the synonyms of a נרדפות bullet. */
function linksOf(line) {
  return [...line.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map((m) => m[1].trim()).filter((w) => HEBREW_WORD.test(w));
}

/**
 * Entries of one page: [title, pointed, pos, defs, syns] per homograph.
 * Pages that are not Hebrew words (other namespaces, Latin titles,
 * redirects) give nothing.
 */
export function parsePage(title, text) {
  if (!HEBREW_WORD.test(title) || /^#(?:הפניה|redirect)/i.test(text.trim())) return [];
  const out = [];
  const sections = text.split(/^==([^=].*?)==\s*$/m);
  // split → [before, heading1, body1, heading2, body2, …]
  for (let i = 1; i < sections.length; i += 2) {
    const head = plainText(sections[i]);
    const body = sections[i + 1] ?? "";
    if (!head || !/[א-ת]/.test(head)) continue;
    const pointed = head.replace(/\s*\d+$/, "");
    const boxMatch = /\{\{ניתוח דקדוקי([\s\S]*?)\n\}\}/.exec(body);
    const pos = boxMatch ? boxField(boxMatch[1], "חלק דיבר").replace(/־/g, " ") : "";
    const defs = [];
    const syns = [];
    let inSyn = false;
    for (const raw of body.split("\n")) {
      const line = raw.trimEnd();
      const h = /^={3,}\s*(.*?)\s*={3,}$/.exec(line);
      if (h) {
        inSyn = SYN_HEADING.test(plainText(h[1]));
        continue;
      }
      if (inSyn) {
        if (/^[*#:]/.test(line)) for (const w of linksOf(line)) if (w !== title && !syns.includes(w)) syns.push(w);
        continue;
      }
      // A definition: "# text"; "#:", "#*" and "##" are examples, quotes and sub-senses.
      const d = /^#(?![:*#])\s*(.+)$/.exec(line);
      if (d && defs.length < MAX_DEFS) {
        const txt = plainText(d[1]);
        if (txt && /[א-ת]/.test(txt)) defs.push(txt.length > MAX_DEF_CHARS ? txt.slice(0, MAX_DEF_CHARS - 1) + "…" : txt);
      }
    }
    if (defs.length || syns.length) out.push([title, pointed, pos, defs, syns]);
  }
  return out;
}

/** The pack file: entries sorted by word, then by pointed form. */
export function buildPack(entries, { source, built }) {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return {
    format: PACK_FORMAT,
    source,
    built,
    license: "CC-BY-SA-4.0",
    attribution: `Hebrew Wiktionary (he.wiktionary.org) contributors, ${source}, CC BY-SA 4.0. Definitions shortened; examples removed.`,
    count: sorted.length,
    words: new Set(sorted.map((e) => e[0])).size,
    entries: sorted,
  };
}

/** Pages of a MediaWiki XML export, one at a time: [title, ns, text]. */
export function* pagesOf(xmlChunk) {
  for (const m of xmlChunk.matchAll(/<page>([\s\S]*?)<\/page>/g)) {
    const p = m[1];
    const title = /<title>([^<]*)<\/title>/.exec(p)?.[1] ?? "";
    const ns = /<ns>(\d+)<\/ns>/.exec(p)?.[1] ?? "";
    const text = /<text[^>]*>([\s\S]*?)<\/text>/.exec(p)?.[1] ?? "";
    yield [unescapeXml(title), ns, unescapeXml(text)];
  }
}

export function unescapeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
}
