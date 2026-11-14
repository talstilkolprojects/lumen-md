/**
 * NTREX-128 based parts. NTREX's 1,997 lines are split in two halves by a
 * public hash of the line number, so the two sets never share a sentence:
 *   mt-he-en/ntrex     — he→en pairs from the mt half;
 *   typos-he/synthetic — sentences of the typos half with injected errors.
 */
import { rankKey, shuffle, splitPool, splitPoolWith } from "../../lib/golden.mjs";
import { wordCount } from "../common.mjs";
import { fetchText, rawUrl, sha256 } from "../fetch.mjs";
import { SRC } from "../defs.mjs";

const lines = (s) => s.replace(/\r/g, "").split("\n").slice(0, 1997);

export function loadNtrex(cache) {
  const s = SRC.ntrex;
  const get = (path) => fetchText(cache, rawUrl(s.repo, s.commit, path), { sha: s.files[path] ?? undefined, name: `ntrex-${path.replace(/\W+/g, "_")}` });
  const he = lines(get("NTREX-128/newstest2019-ref.heb.txt"));
  const en = lines(get("NTREX-128/newstest2019-src.eng.txt"));
  const docsText = get("DOCUMENT_IDS.tsv");
  const docs = lines(docsText);
  if (he.length !== 1997 || en.length !== 1997 || docs.length !== 1997) throw new Error("NTREX: expected 1,997 aligned lines");
  return {
    rows: he.map((h, i) => ({ line: i + 1, doc: docs[i].trim(), he: h.trim(), en: en[i].trim() })),
    provenance: {
      repo: `https://github.com/${s.repo}`,
      commit: s.commit,
      files: { "NTREX-128/newstest2019-ref.heb.txt": s.files["NTREX-128/newstest2019-ref.heb.txt"], "NTREX-128/newstest2019-src.eng.txt": s.files["NTREX-128/newstest2019-src.eng.txt"], "DOCUMENT_IDS.tsv": sha256(docsText) },
    },
  };
}

/** Which half of NTREX a line belongs to (public; the two sets never overlap). */
export const ntrexHalf = (line) => (rankKey("lumen-golden-v1:ntrex-halves", String(line))[0] < "8" ? "mt" : "typos");

const lineId = (prefix, line) => `${prefix}-${String(line).padStart(4, "0")}`;

export const ntrex = {
  pool(ctx) {
    const { rows, provenance } = loadNtrex(ctx.cache);
    const items = rows
      .filter((r) => ntrexHalf(r.line) === "mt" && r.he && r.en && wordCount(r.he) >= 4 && wordCount(r.he) <= 45)
      .map((r) => ({ id: lineId("ntrex", r.line), line: r.line, doc: r.doc, he: r.he, en: r.en }));
    return { items, provenance };
  },
  select: (pool, opts) => splitPool(pool.items, opts),
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: the mt half of NTREX (sha256(\"lumen-golden-v1:ntrex-halves\\0<line>\") < 8…), lines with 4–45 Hebrew words; dev and test drawn by splitPool (scripts/lib/golden.mjs)" },
    fields: { he: "Hebrew (NTREX human translation of the English source)", en: "English reference (the WMT19 source)", line: "1-based line in NTREX-128", doc: "NTREX document id" },
    direction: "he→en",
  }),
};

// ── Synthetic spelling errors ───────────────────────────────────────────

/** Hebrew SI-1452 keyboard rows (letters only), for neighbour substitutions. */
const ROWS = ["קראטוןםפ", "שדגכעיחלךף", "זסבהנמצתץ"];
const NEIGHBOURS = {};
for (const row of ROWS)
  for (let i = 0; i < row.length; i++) NEIGHBOURS[row[i]] = [row[i - 1], row[i + 1]].filter(Boolean);
const SOUND = { ט: "ת", ת: "ט", כ: "ח", ח: "כ", ק: "כ", א: "ע", ע: "א", ס: "ש", ש: "ס", ב: "ו", ו: "ב" };
const FINAL = { ם: "מ", ן: "נ", ץ: "צ", ף: "פ", ך: "כ" };
const TO_FINAL = Object.fromEntries(Object.entries(FINAL).map(([f, m]) => [m, f]));
const PREFIX = new Set(["ו", "ה", "ב", "ל", "מ", "ש", "כ"]);
const SHORT_FUNCTION = new Set(["של", "את", "על", "עם", "אל", "כי", "גם", "לא", "זה", "יש", "אם", "או", "רק", "כל"]);
const TYPES = ["keyboard", "sound", "final", "transpose", "delete", "double", "split", "join"];

/** One corruption of `word` (letters only) of the given type, chosen by `h` (hex), or null. */
function corrupt(word, type, h) {
  const n = word.length;
  const pick = (k, mod) => parseInt(h.slice(k * 4, k * 4 + 4), 16) % mod;
  const chars = Array.from(word);
  if (type === "keyboard") {
    const pos = chars.map((c, i) => (NEIGHBOURS[c]?.length ? i : -1)).filter((i) => i >= 0);
    if (!pos.length) return null;
    const i = pos[pick(0, pos.length)];
    const nb = NEIGHBOURS[chars[i]];
    chars[i] = nb[pick(1, nb.length)];
  } else if (type === "sound") {
    const pos = chars.map((c, i) => (SOUND[c] && !(c === "כ" && i === n - 1) ? i : -1)).filter((i) => i >= 0);
    if (!pos.length) return null;
    const i = pos[pick(0, pos.length)];
    chars[i] = SOUND[chars[i]];
  } else if (type === "final") {
    if (FINAL[chars[n - 1]]) chars[n - 1] = FINAL[chars[n - 1]];
    else {
      const pos = chars.slice(0, -1).map((c, i) => (TO_FINAL[c] ? i : -1)).filter((i) => i >= 0);
      if (!pos.length) return null;
      const i = pos[pick(0, pos.length)];
      chars[i] = TO_FINAL[chars[i]];
    }
  } else if (type === "transpose") {
    const pos = chars.slice(0, -1).map((c, i) => (c !== chars[i + 1] ? i : -1)).filter((i) => i >= 0);
    if (!pos.length) return null;
    const i = pos[pick(0, pos.length)];
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  } else if (type === "delete") {
    if (n < 4) return null;
    chars.splice(1 + pick(0, n - 1), 1);
  } else if (type === "double") {
    const pos = chars.map((c, i) => (c !== "ו" && c !== "י" && !FINAL[c] ? i : -1)).filter((i) => i >= 0);
    if (!pos.length) return null;
    const i = pos[pick(0, pos.length)];
    chars.splice(i, 0, chars[i]);
  } else if (type === "split") {
    if (n < 4 || !PREFIX.has(chars[0])) return null;
    return `${chars[0]} ${chars.slice(1).join("")}`;
  } else return null;
  // A final form that ends up mid-word or a regular one at the end is fine: that *is* the error.
  return chars.join("");
}

export const typos = {
  pool(ctx) {
    const { rows, provenance } = loadNtrex(ctx.cache);
    const vocab = new Map();
    for (const r of rows) for (const w of r.he.match(/[\u05D0-\u05EA]+/g) ?? []) vocab.set(w, (vocab.get(w) ?? 0) + 1);
    const items = rows
      .filter((r) => {
        if (ntrexHalf(r.line) !== "typos") return false;
        const wc = wordCount(r.he);
        const latin = (r.he.match(/[A-Za-z]/g) ?? []).length;
        return wc >= 6 && wc <= 30 && latin <= 2 && !/[‚‘’]/.test(r.he);
      })
      .map((r) => ({ id: lineId("typo", r.line), line: r.line, he: r.he }));
    return { items, provenance, vocab };
  },
  select: (pool, opts) => splitPoolWith(pool.items, opts, (r, seed) => inject(r, pool.vocab, seed)),
  meta: (pool, items) => {
    const byType = {};
    for (const it of items) for (const e of it.errors) byType[e.type] = (byType[e.type] ?? 0) + 1;
    return {
      source: { ...pool.provenance, sampling: "pool: the typos half of NTREX, 6–30 words, ≤ 2 Latin letters; sentences and their errors are drawn by splitPoolWith with the split's seed (public for dev, GOLDEN_SEED for test)" },
      fields: {
        text: "the sentence with the errors (what a spellchecker sees)",
        clean: "the original NTREX sentence (also the clean text for false positives)",
        errors: "[{start, end, wrong, right, type, nonword}] — offsets (UTF-16, JS string indices) into `text`; nonword = the wrong form never occurs in NTREX (a heuristic, no dictionary)",
      },
      errorTypes: byType,
    };
  },
};

/** Inject 1 (70%) or 2 (30%) errors into a sentence; null when no valid corruption exists. */
function inject(r, vocab, seed) {
  const h = rankKey(seed, `line:${r.line}`);
  const want = parseInt(h.slice(0, 2), 16) < 77 ? 2 : 1;
  const tokens = [...r.he.matchAll(/[\u05D0-\u05EA]+/g)].map((m) => ({ w: m[0], s: m.index, e: m.index + m[0].length }));
  const edits = [];
  const taken = new Set();
  const order = shuffle(tokens.map((t, i) => ({ ...t, i })), `${seed}:words:${r.line}`, (t) => t.i);
  for (const t of order) {
    if (edits.length === want) break;
    if (taken.has(t.i)) continue;
    const typeOrder = shuffle(TYPES, `${seed}:types:${r.line}:${t.i}`, (x) => x);
    for (const type of typeOrder) {
      if (type === "join") {
        const next = tokens[t.i + 1];
        if (!SHORT_FUNCTION.has(t.w) || !next || taken.has(t.i + 1) || r.he.slice(t.e, next.s) !== " ") continue;
        const joined = t.w + next.w;
        if (vocab.has(joined)) continue;
        edits.push({ s: t.s, e: next.e, wrong: joined, right: r.he.slice(t.s, next.e), type, nonword: true });
        taken.add(t.i).add(t.i + 1);
        break;
      }
      if (t.w.length < 3 || (vocab.get(t.w) ?? 0) < 3) break;
      const wrong = corrupt(t.w, type, rankKey(seed, `${r.line}:${t.i}:${type}`));
      if (!wrong || wrong === t.w) continue;
      const nonword = type === "split" ? true : !vocab.has(wrong);
      if (!nonword) continue;
      edits.push({ s: t.s, e: t.e, wrong, right: t.w, type, nonword });
      taken.add(t.i);
      break;
    }
  }
  if (!edits.length) return null;
  edits.sort((a, b) => a.s - b.s);
  let text = "";
  let at = 0;
  const errors = [];
  for (const ed of edits) {
    text += r.he.slice(at, ed.s);
    errors.push({ start: text.length, end: text.length + ed.wrong.length, wrong: ed.wrong, right: ed.right, type: ed.type, nonword: ed.nonword });
    text += ed.wrong;
    at = ed.e;
  }
  text += r.he.slice(at);
  return { id: r.id, line: r.line, text, clean: r.he, errors };
}
