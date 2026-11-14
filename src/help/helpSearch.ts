/**
 * Offline help search (plan W3.7): the in-app docs (./generated/help.*.json)
 * searched on the device — no network, no index server.
 *
 * The same rules as the docs site's Hebrew search (docs/src/plugins/
 * hebrew-forms.mjs, plan W1.28), so the two answer alike: a query word
 * matches the start of an indexed word; Hebrew prefix letters (ו ה ב ל מ ש כ)
 * come off indexed words ("והפתקים" is also found as "פתקים"), and a
 * construct-state ending ת also counts as ה ("התקנת" → "התקנה"). Pages rank by
 * weighted matches (title 10, heading 4, text 1; title forms 5, text forms
 * 0.5) over the log of their length; every query word must match. The best
 * section of a page gives the deep link.
 */

export interface HelpSection {
  heading: string;
  /** The anchor the renderer gives the heading in this language. */
  anchor: string;
  /** The same section's English anchor: what a "?" button names. */
  key: string;
  text: string;
}
export interface HelpPage {
  slug: string;
  title: string;
  description: string;
  md: string;
  sections: HelpSection[];
}
export interface HelpBundle {
  version: number;
  lang: "en" | "he";
  pages: HelpPage[];
}

const PREFIX = new Set(["ו", "ה", "ב", "ל", "מ", "ש", "כ"]);
const POINTS = /[\u{0591}-\u{05C7}]/gu;

/** Words of a text: letters and digits, lowercased, without niqqud; Hebrew geresh / quotes kept inside a word. */
export function tokens(s: string): string[] {
  return [...s.normalize("NFC").replace(POINTS, "").toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}"'׳״]*/gu)].map((m) => m[0].replace(/["'׳״]+$/u, ""));
}

/** Query words: a hyphen splits ("מ-Notion" → "מ", "notion"); one-letter words are dropped. */
export function queryWords(q: string): string[] {
  return tokens(q.replace(/-/g, " ")).filter((w) => w.length > 1);
}

const HEBREW = /^[א-ת]/;

/** The bare forms of a Hebrew word (one and two prefix letters off, three letters left at least) and their absolute forms. */
export function hebrewForms(word: string): string[] {
  if (!HEBREW.test(word)) return [];
  const out: string[] = [];
  let w = word;
  const add = (f: string) => {
    if (f !== word && !out.includes(f)) out.push(f);
    if (f.length >= 4 && f.endsWith("ת")) {
      const a = `${f.slice(0, -1)}ה`;
      if (!out.includes(a) && a !== word) out.push(a);
    }
  };
  add(w);
  for (let i = 0; i < 2 && w.length > 3 && PREFIX.has(w[0]); i++) {
    w = w.slice(1);
    add(w);
  }
  return out;
}

interface Indexed {
  page: HelpPage;
  /** word → weight, for the page; per section the same. */
  words: Map<string, number>;
  sections: Array<Map<string, number>>;
  length: number;
}

function addWords(map: Map<string, number>, text: string, weight: number, formWeight: number) {
  let n = 0;
  for (const w of tokens(text)) {
    map.set(w, (map.get(w) ?? 0) + weight);
    for (const f of hebrewForms(w)) map.set(f, (map.get(f) ?? 0) + formWeight);
    n++;
  }
  return n;
}

export class HelpIndex {
  private readonly items: Indexed[];
  constructor(readonly bundle: HelpBundle) {
    this.items = bundle.pages.map((page) => {
      const words = new Map<string, number>();
      let length = addWords(words, page.title, 10, 5);
      addWords(words, page.description, 2, 0.5);
      const sections = page.sections.map((s) => {
        const m = new Map<string, number>();
        length += addWords(words, s.heading, 4, 2) + addWords(words, s.text, 1, 0.5);
        addWords(m, s.heading, 4, 2);
        addWords(m, s.text, 1, 0.5);
        return m;
      });
      return { page, words, sections, length: Math.max(50, length) };
    });
  }

  page(slug: string): HelpPage | undefined {
    return this.bundle.pages.find((p) => p.slug === slug);
  }

  /** This language's anchor for a section key (the English anchor), or "". */
  anchorFor(slug: string, key: string | undefined): string {
    if (!key) return "";
    return this.page(slug)?.sections.find((s) => s.key === key || s.anchor === key)?.anchor ?? "";
  }

  /** Pages for a query, best first, each with its best section's anchor. */
  search(q: string, limit = 10): Array<{ page: HelpPage; score: number; anchor: string; heading: string }> {
    const terms = queryWords(q);
    if (!terms.length) return [];
    const scoreIn = (words: Map<string, number>) => {
      let total = 0;
      for (const t of terms) {
        let s = 0;
        for (const [w, weight] of words) if (w.startsWith(t)) s += weight;
        if (!s) return 0;
        total += s;
      }
      return total;
    };
    const out: Array<{ page: HelpPage; score: number; anchor: string; heading: string }> = [];
    for (const it of this.items) {
      const s = scoreIn(it.words);
      if (!s) continue;
      let best = -1;
      let bestScore = 0;
      it.sections.forEach((m, i) => {
        const v = scoreIn(m);
        if (v > bestScore) {
          bestScore = v;
          best = i;
        }
      });
      const sec = best >= 0 ? it.page.sections[best] : undefined;
      out.push({ page: it.page, score: s / Math.log2(it.length), anchor: sec?.anchor ?? "", heading: sec?.heading ?? it.page.title });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

const cache: Partial<Record<"en" | "he", Promise<HelpIndex>>> = {};

/**
 * The packed docs come in shards (scripts/help-bundle.mjs), each its own
 * lazy chunk under the 100 KB lazy-chunk budget. Not eager: nothing loads
 * until the help panel asks.
 */
const SHARDS: Record<"en" | "he", Record<string, () => Promise<HelpBundle>>> = {
  en: import.meta.glob<HelpBundle>("./generated/help.en.*.json", { import: "default" }),
  he: import.meta.glob<HelpBundle>("./generated/help.he.*.json", { import: "default" }),
};

/** Shard paths in order: help.he.2.json before help.he.10.json. */
const shardNo = (path: string) => Number(/\.(\d+)\.json$/.exec(path)?.[1] ?? 0);

/** The help index for a UI language (Hebrew for he, English otherwise), loaded once, lazily. */
export function loadHelp(locale: string): Promise<HelpIndex> {
  const lang = locale === "he" ? "he" : "en";
  const loaders = Object.entries(SHARDS[lang]).sort(([a], [b]) => shardNo(a) - shardNo(b));
  cache[lang] ??= Promise.all(loaders.map(([, load]) => load())).then(
    (parts) => new HelpIndex({ version: parts[0]?.version ?? 1, lang, pages: parts.flatMap((p) => p.pages) }),
  );
  return cache[lang]!;
}
