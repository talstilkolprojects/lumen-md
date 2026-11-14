/**
 * The vault organizer's analysis (plan W2.1): suggestions over the whole
 * vault, each a change to approve in the review screen (plan 5.11).
 *
 *   link   a note mentions another note's title but does not link to it
 *          → the first mention becomes `[[Title]]` (or `[[Title|mention]]`)
 *   tag    a tag used in the vault fits a note that lacks it (the tag's
 *          word appears in it, and/or notes it links with carry the tag)
 *          → the tag is added to its front matter
 *   merge  two notes are near duplicates (word 5-gram overlap)
 *          → the newer one's extra paragraphs go into the older one, and
 *            the newer one becomes a pointer to it
 *   moc    a tag has many notes and no note links to most of them
 *          → a new map-of-content note listing them
 *
 * Every suggestion has a confidence (0–1), an explanation (an i18n key
 * with its values) and a quote from the notes it is based on. It is pure
 * and deterministic: no model, same answer in Hebrew and English. Hebrew
 * words match with or without one prefix letter (ו ה ב ל מ ש כ) and niqqud.
 */
import { frontmatterTags, mergeTags } from "../../ai/batch";

export type OrganizerKind = "link" | "tag" | "merge" | "moc";

export interface OrganizerNote {
  path: string;
  text: string;
}

export interface OrganizerChange {
  path: string;
  /** Text the change is computed from; null: a new note. */
  before: string | null;
  /** The whole note after this change alone. */
  after: string;
  /**
   * The edit as a range of `before` (links, tags): staged as a range change,
   * so several of them in one note can be approved in any order.
   */
  range?: { from: number; to: number; before: string; after: string };
}

export interface OrganizerSuggestion {
  id: string;
  kind: OrganizerKind;
  changes: OrganizerChange[];
  /** 0–1, after learning (learning.ts). */
  confidence: number;
  /** i18n key (`organizer.reason.*`) and its values. */
  reason: { key: string; params: Record<string, string | number> };
  /** What it is based on, verbatim from a note. */
  quote: { path: string; text: string };
  /** What approvals and rejections are learned under (`link`, `tag:<tag>`, …). */
  features: string[];
}

export interface AnalyzeOptions {
  /** Suggestions below this are dropped (default 0.5). */
  minConfidence?: number;
  /** Folder for new map-of-content notes (default `maps`). */
  mocFolder?: string;
  /** A tag needs this many notes for a map of content (default 6). */
  mocMinNotes?: number;
  /** Jaccard of word 5-grams for a duplicate (default 0.7). */
  duplicateThreshold?: number;
}

const NIQQUD = /[֑-ׇ]/g;
const HEB = /[א-ת]/;
const HEB_PREFIX = "ובהלמשכ";
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu;

export function normWord(w: string): string {
  return w.toLowerCase().replace(NIQQUD, "").replace(/['’-]+$/, "");
}

/** The word and (Hebrew, > 3 letters, starting with a prefix letter) the word without it. */
function variants(w: string): string[] {
  const n = normWord(w);
  return HEB.test(n) && n.length > 3 && HEB_PREFIX.includes(n[0]) ? [n, n.slice(1)] : [n];
}

export function basenameOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.(md|markdown|txt)$/i, "");
}

function bodyStart(text: string): number {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? m[0].length : 0;
}

export function titleOf(note: OrganizerNote): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(note.text)?.[1];
  const t = fm ? /^title\s*:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1] : undefined;
  if (t) return t.trim();
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(note.text.slice(bodyStart(note.text), bodyStart(note.text) + 4000));
  return h ? h[1].trim() : basenameOf(note.path);
}

/** Link targets in a note (basename, lower case). */
export function linkTargets(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) out.add(normWord(basenameOf(m[1].trim())).replace(/\s+/g, " "));
  for (const m of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) out.add(normWord(basenameOf(decodeURIComponent(m[1]))));
  return out;
}

/**
 * Ranges where a mention must not be linked: front matter, fenced and
 * inline code, existing wiki / Markdown links, headings, URLs.
 */
function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const fm = bodyStart(text);
  if (fm) out.push([0, fm]);
  for (const re of [/```[\s\S]*?```|~~~[\s\S]*?~~~/g, /`[^`\n]*`/g, /\[\[[^\]]*\]\]/g, /\[[^\]]*\]\([^)]*\)/g, /^#{1,6} .*$/gm, /https?:\/\/\S+/g]) {
    for (const m of text.matchAll(re)) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return out;
}

const inRanges = (r: [number, number][], from: number, to: number) => r.some(([a, b]) => from < b && to > a);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The sentence around [from, to), trimmed to ~160 characters. */
export function sentenceAt(text: string, from: number, to: number): string {
  let a = from;
  while (a > 0 && !/[.!?\n]/.test(text[a - 1])) a--;
  let b = to;
  while (b < text.length && !/[.!?\n]/.test(text[b])) b++;
  if (b < text.length && text[b] !== "\n") b++;
  let s = text.slice(a, b).trim();
  if (s.length > 160) {
    const at = from - a;
    s = (at > 70 ? "…" : "") + s.slice(Math.max(0, at - 70), at + 90).trim() + (at + 90 < s.length ? "…" : "");
  }
  return s;
}

/** Where `title` occurs in `text` as whole words (a Hebrew title also after one prefix letter). */
export function findMention(text: string, title: string, skip: [number, number][]): { from: number; to: number; prefix: number } | null {
  const words = title.trim().split(/\s+/).map(escapeRe).join("[\\s\\u00A0]+");
  if (!words) return null;
  const hebrew = HEB.test(title);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${hebrew ? `[${HEB_PREFIX}]?` : ""})(${words})(?![\\p{L}\\p{N}_])`, "giu");
  for (const m of text.normalize("NFC").matchAll(re)) {
    const from = (m.index ?? 0) + m[1].length;
    const to = from + m[2].length;
    if (!inRanges(skip, m.index ?? 0, to)) return { from, to, prefix: m[1].length };
  }
  return null;
}

const clamp = (n: number) => Math.max(0, Math.min(0.99, Math.round(n * 100) / 100));

function shingles(text: string): Set<string> {
  const words = (text.slice(bodyStart(text)).match(WORD) ?? []).map(normWord);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i++) out.add(words.slice(i, i + 5).join(" "));
  return out;
}

function paragraphs(text: string): string[] {
  return text
    .slice(bodyStart(text))
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const plainTag = (t: string) => t.replace(/^#/, "").trim();

export function analyzeVault(input: readonly OrganizerNote[], opts: AnalyzeOptions = {}): OrganizerSuggestion[] {
  const minConfidence = opts.minConfidence ?? 0.5;
  const notes = input.filter((n) => /\.(md|markdown)$/i.test(n.path)).map((n) => ({ ...n, text: n.text.normalize("NFC") }));
  const out: OrganizerSuggestion[] = [];
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const titles = new Map(notes.map((n) => [n.path, titleOf(n)]));
  const targets = new Map(notes.map((n) => [n.path, linkTargets(n.text)]));
  const tags = new Map(notes.map((n) => [n.path, frontmatterTags(n.text).map(plainTag).filter(Boolean)]));
  // Word → notes containing it (with Hebrew prefix variants), for candidate lookup.
  const wordIndex = new Map<string, Set<string>>();
  const wordCounts = new Map<string, Map<string, number>>();
  for (const n of notes) {
    const counts = new Map<string, number>();
    for (const w of n.text.slice(bodyStart(n.text)).match(WORD) ?? []) {
      for (const v of variants(w)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    wordCounts.set(n.path, counts);
    for (const v of counts.keys()) {
      let s = wordIndex.get(v);
      if (!s) wordIndex.set(v, (s = new Set()));
      s.add(n.path);
    }
  }
  const linked = (a: string, b: string) => {
    const tb = normWord(basenameOf(b));
    const tt = normWord(titles.get(b) ?? "");
    const ta = targets.get(a)!;
    return ta.has(tb) || ta.has(tt);
  };
  const neighbours = (p: string) => notes.filter((o) => o.path !== p && (linked(p, o.path) || linked(o.path, p))).map((o) => o.path);
  const tagCount = new Map<string, number>();
  for (const list of tags.values()) for (const t of new Set(list.map((x) => x.toLowerCase()))) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);

  /* ── links ── */
  const titleNotes = new Map<string, string[]>();
  for (const n of notes) {
    const key = normWord(titles.get(n.path)!);
    titleNotes.set(key, [...(titleNotes.get(key) ?? []), n.path]);
  }
  for (const b of notes) {
    const title = titles.get(b.path)!;
    const words = title.match(WORD) ?? [];
    const letters = title.replace(/[^\p{L}\p{N}]/gu, "").length;
    // Too short or ambiguous to link reliably.
    if (!words.length || letters < 3 || (titleNotes.get(normWord(title))?.length ?? 0) > 1) continue;
    const first = normWord(words[0]!);
    const candidates = new Set<string>(wordIndex.get(first) ?? []);
    for (const v of variants(words[0]!)) for (const p of wordIndex.get(v) ?? []) candidates.add(p);
    for (const ap of candidates) {
      if (ap === b.path || linked(ap, b.path)) continue;
      const text = byPath.get(ap)!.text;
      const m = findMention(text, title, protectedRanges(text));
      if (!m) continue;
      const mention = text.slice(m.from, m.to);
      const base = basenameOf(b.path);
      const link = mention === base ? `[[${base}]]` : `[[${base}|${mention}]]`;
      const after = text.slice(0, m.from) + link + text.slice(m.to);
      const mentions = (text.slice(bodyStart(text)).toLowerCase().match(new RegExp(escapeRe(normWord(title)), "g")) ?? []).length;
      const sharedTags = (tags.get(ap) ?? []).filter((t) => (tags.get(b.path) ?? []).some((u) => u.toLowerCase() === t.toLowerCase())).length;
      let conf = 0.55 + Math.min(0.2, 0.1 * (words.length - 1)) + (letters >= 6 ? 0.1 : 0) + (mentions > 1 ? 0.05 : 0) + (sharedTags ? 0.1 : 0);
      if (words.length === 1 && letters < 5) conf -= 0.15;
      // A one-word title that is a common word in this vault ("Notes", "סיכום") is usually not meant as the note.
      if (words.length === 1 && (wordIndex.get(first)?.size ?? 0) > Math.max(3, 0.1 * notes.length)) conf -= 0.25;
      conf = clamp(conf);
      if (conf < minConfidence) continue;
      out.push({
        id: `link:${ap}→${b.path}`,
        kind: "link",
        changes: [{ path: ap, before: text, after, range: { from: m.from, to: m.to, before: mention, after: link } }],
        confidence: conf,
        reason: { key: "organizer.reason.link", params: { title, note: basenameOf(ap) } },
        quote: { path: ap, text: sentenceAt(text, m.from, m.to) },
        features: ["link"],
      });
    }
  }

  /* ── tags ── */
  for (const n of notes) {
    const own = new Set((tags.get(n.path) ?? []).map((t) => t.toLowerCase()));
    const near = neighbours(n.path);
    const counts = wordCounts.get(n.path)!;
    const add: { tag: string; conf: number; quote: string }[] = [];
    for (const [tag, count] of tagCount) {
      if (count < 2 || own.has(tag)) continue;
      const tagWords = tag.split(/[\s/_-]+/).filter(Boolean).map(normWord);
      const occurs = tagWords.length === 1 ? (counts.get(tagWords[0]) ?? 0) : 0;
      const nearWith = near.filter((p) => (tags.get(p) ?? []).some((t) => t.toLowerCase() === tag)).length;
      if (!occurs && nearWith < 2) continue;
      const conf = clamp(0.4 + Math.min(0.3, 0.12 * occurs) + Math.min(0.25, 0.12 * nearWith) + (count >= 4 ? 0.05 : 0));
      if (conf < minConfidence) continue;
      const text = byPath.get(n.path)!.text;
      const at = occurs ? findMention(text, tagWords[0], protectedRanges(text)) : null;
      add.push({ tag: (tags.get(notes.find((o) => (tags.get(o.path) ?? []).some((t) => t.toLowerCase() === tag))!.path) ?? []).find((t) => t.toLowerCase() === tag) ?? tag, conf, quote: at ? sentenceAt(text, at.from, at.to) : "" });
    }
    const best = add.sort((x, y) => y.conf - x.conf).slice(0, 3);
    if (!best.length) continue;
    // One suggestion per note (a front-matter edit each would overlap), learned per tag.
    const before = byPath.get(n.path)!.text;
    const after = mergeTags(before, best.map((a) => a.tag));
    if (after === before) continue;
    const fmEnd = bodyStart(before);
    const body = before.slice(fmEnd);
    const newFm = after.endsWith(body) ? after.slice(0, after.length - body.length) : null;
    const range = newFm === null ? undefined : { from: 0, to: fmEnd, before: before.slice(0, fmEnd), after: newFm };
    const top = best[0];
    const nearWith = near.filter((p) => (tags.get(p) ?? []).some((t) => t.toLowerCase() === top.tag.toLowerCase()));
    const list = best.map((a) => a.tag).join(", ");
    out.push({
      id: `tag:${n.path}`,
      kind: "tag",
      changes: [{ path: n.path, before, after, ...(range ? { range } : {}) }],
      confidence: clamp(best.reduce((m, a) => m + a.conf, 0) / best.length),
      reason: top.quote ? { key: "organizer.reason.tagWord", params: { tag: list, count: tagCount.get(top.tag.toLowerCase()) ?? 0 } } : { key: "organizer.reason.tagNear", params: { tag: list, near: nearWith.map(basenameOf).slice(0, 3).join(", ") } },
      quote: top.quote ? { path: n.path, text: top.quote } : { path: nearWith[0] ?? n.path, text: titles.get(nearWith[0] ?? n.path) ?? "" },
      features: ["tag", ...best.map((a) => `tag:${a.tag.toLowerCase()}`)],
    });
  }

  /* ── duplicates ── */
  const sh = new Map(notes.map((n) => [n.path, shingles(n.text)]));
  const postings = new Map<string, string[]>();
  for (const [p, s] of sh) for (const g of s) postings.set(g, [...(postings.get(g) ?? []), p]);
  const overlap = new Map<string, number>();
  for (const list of postings.values()) {
    if (list.length < 2 || list.length > 12) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const key = list[i] < list[j] ? `${list[i]}\u0000${list[j]}` : `${list[j]}\u0000${list[i]}`;
      overlap.set(key, (overlap.get(key) ?? 0) + 1);
    }
  }
  const merged = new Set<string>();
  for (const [key, inter] of [...overlap].sort((x, y) => y[1] - x[1])) {
    const [a, b] = key.split("\u0000");
    if (merged.has(a) || merged.has(b)) continue;
    const sa = sh.get(a)!.size;
    const sb = sh.get(b)!.size;
    const jac = inter / (sa + sb - inter);
    if (jac < (opts.duplicateThreshold ?? 0.7) || Math.min(sa, sb) < 4) continue;
    // Keep the longer one (then the first by path); the other points to it.
    const [keep, drop] = sb > sa || (sb === sa && b < a) ? [b, a] : [a, b];
    const keepText = byPath.get(keep)!.text;
    const have = new Set(paragraphs(keepText).map((p) => p.replace(/\s+/g, " ")));
    const extra = paragraphs(byPath.get(drop)!.text).filter((p) => !have.has(p.replace(/\s+/g, " ")) && !/^#\s/.test(p));
    const keepAfter = extra.length ? `${keepText.replace(/\s*$/, "\n")}\n## ${titles.get(drop)}\n\n${extra.join("\n\n")}\n` : keepText;
    const dropText = byPath.get(drop)!.text;
    const dropAfter = `${dropText.slice(0, bodyStart(dropText))}# ${titles.get(drop)}\n\n→ [[${basenameOf(keep)}]]\n`;
    merged.add(a).add(b);
    const changes: OrganizerChange[] = [];
    if (keepAfter !== keepText) changes.push({ path: keep, before: byPath.get(keep)!.text, after: keepAfter });
    changes.push({ path: drop, before: dropText, after: dropAfter });
    const first = [...sh.get(drop)!].find((g) => sh.get(keep)!.has(g)) ?? "";
    out.push({
      id: `merge:${drop}→${keep}`,
      kind: "merge",
      changes,
      confidence: clamp(0.45 + 0.5 * jac),
      reason: { key: "organizer.reason.merge", params: { from: basenameOf(drop), into: basenameOf(keep), percent: Math.round(jac * 100) } },
      quote: { path: drop, text: first },
      features: ["merge"],
    });
  }

  /* ── maps of content ── */
  const folder = (opts.mocFolder ?? "maps").replace(/^\/+|\/+$/g, "");
  for (const [tag, count] of tagCount) {
    if (count < (opts.mocMinNotes ?? 6)) continue;
    const members = notes.filter((n) => (tags.get(n.path) ?? []).some((t) => t.toLowerCase() === tag));
    const covered = notes.some((n) => members.filter((m) => m.path !== n.path && linked(n.path, m.path)).length >= Math.ceil(0.8 * (members.length - 1)));
    const name = (tags.get(members[0].path) ?? []).find((t) => t.toLowerCase() === tag) ?? tag;
    const path = `${folder ? `${folder}/` : ""}${name.replace(/[\\/:*?"<>|#]/g, "-")}.md`;
    if (covered || byPath.has(path)) continue;
    const list = members.map((m) => ({ base: basenameOf(m.path), title: titles.get(m.path)! })).sort((x, y) => x.title.localeCompare(y.title));
    const body = `---\ntags: [${JSON.stringify(name)}]\n---\n# ${name}\n\n${list.map((l) => (l.title === l.base ? `- [[${l.base}]]` : `- [[${l.base}|${l.title}]]`)).join("\n")}\n`;
    out.push({
      id: `moc:${tag}`,
      kind: "moc",
      changes: [{ path, before: null, after: body }],
      confidence: clamp(0.55 + Math.min(0.35, 0.03 * (count - 6))),
      reason: { key: "organizer.reason.moc", params: { tag: name, count } },
      quote: { path: members[0].path, text: list.slice(0, 3).map((l) => l.title).join(" · ") },
      features: ["moc"],
    });
  }

  return out.sort((x, y) => y.confidence - x.confidence || x.id.localeCompare(y.id));
}
