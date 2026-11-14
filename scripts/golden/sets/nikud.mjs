/**
 * nikud parts.
 *   benyehuda — fully pointed sentences and verse lines from public-domain
 *               works of Project Ben-Yehuda (the owner proofreads, 15.11).
 *   nakdimon  — modern sentences from Nakdimon's tests/new set. Local only:
 *               the dev selection keeps ids, paths, lines and sha256.
 */
import { shuffle, splitPool } from "../../lib/golden.mjs";
import { HEB_LETTER, parseCsv, sentences, stripNikud, vocalisedShare, wordCount } from "../common.mjs";
import { fetchText, gitList, rawUrl, sha256 } from "../fetch.mjs";
import { SRC } from "../defs.mjs";

/** Letters that may stay unpointed in a fully pointed text: matres lectionis and final forms. */
const MAY_BE_BARE = new Set([..."\u05D0\u05D4\u05D5\u05D9\u05DD\u05DF\u05E5\u05E3"]);
const POINT = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/;

/** Fully pointed: every letter but א ה ו י and final ם ן ץ ף carries a mark (≤ 3% missing), ≥ 12 such letters. */
export function fullyPointed(s) {
  const ch = Array.from(s);
  let need = 0;
  let miss = 0;
  for (let i = 0; i < ch.length; i++) {
    if (!HEB_LETTER.test(ch[i]) || MAY_BE_BARE.has(ch[i])) continue;
    need++;
    if (!POINT.test(ch[i + 1] ?? "")) miss++;
  }
  return need >= 12 && miss / need <= 0.03;
}

/** A unit a diacritiser can be scored on: 5–25 words, Hebrew only, fully pointed. */
function goodUnit(s) {
  const wc = wordCount(s);
  if (wc < 5 || wc > 25) return false;
  if (/[0-9A-Za-z\[\]{}<>|=_*#@]/.test(s)) return false;
  return fullyPointed(s);
}

/** Sentences of each paragraph, and its lines (verse has no full stops). */
function units(text) {
  const out = new Set();
  for (const para of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    for (const s of sentences(para)) out.add(s);
    for (const l of para.split("\n")) out.add(l.trim().replace(/\s+/g, " "));
  }
  return [...out].filter(goodUnit);
}

const POOL_TARGET = 150;
const MAX_FETCH = 1500;

export const benyehuda = {
  /** Public pool: works scanned in a fixed order (poetry first) until 150 fully pointed units are found. */
  pool(ctx) {
    const s = SRC.benyehuda;
    const catText = fetchText(ctx.cache, rawUrl(s.repo, s.commit, "pseudocatalogue.csv"), { sha: s.files["pseudocatalogue.csv"], name: "benyehuda-pseudocatalogue.csv" });
    const genreOf = (g) => g.replace(/^Translation missing: he\./, "");
    const works = parseCsv(catText).filter((w) => ["poetry", "prose", "fables", "memoir", "drama"].includes(genreOf(w.genre)) && !w.translators && vocalisedShare(w.title) >= 0.6 && /^\/p\d+\/m\d+$/.test(w.path));
    const order = [...shuffle(works.filter((w) => genreOf(w.genre) === "poetry"), "lumen-golden-v1:nikud:benyehuda:pool", (w) => w.ID), ...shuffle(works.filter((w) => genreOf(w.genre) !== "poetry"), "lumen-golden-v1:nikud:benyehuda:pool", (w) => w.ID)];
    const items = [];
    const files = {};
    const perAuthor = new Map();
    let fetched = 0;
    for (const w of order) {
      if (items.length >= POOL_TARGET) break;
      if ((perAuthor.get(w.authors) ?? 0) >= 6) continue;
      if (++fetched > MAX_FETCH) break;
      const path = `txt${w.path}.txt`;
      let text;
      try {
        text = fetchText(ctx.cache, rawUrl(s.repo, s.commit, path), { name: `benyehuda-${w.ID}.txt` });
      } catch {
        continue;
      }
      const found = units(text).slice(0, 3);
      if (!found.length) continue;
      files[path] = sha256(text);
      perAuthor.set(w.authors, (perAuthor.get(w.authors) ?? 0) + found.length);
      found.forEach((t, k) => items.push({ id: `by-${w.ID}-${k + 1}`, text: t, plain: stripNikud(t), work: { id: Number(w.ID), title: w.title, author: w.authors, genre: genreOf(w.genre), url: `https://benyehuda.org/read/${w.ID}` } }));
    }
    if (items.length < 100) throw new Error(`benyehuda: only ${items.length} fully pointed units after ${fetched} works`);
    return { items, provenance: { repo: `https://github.com/${s.repo}`, commit: s.commit, files: { "pseudocatalogue.csv": s.files["pseudocatalogue.csv"], ...files }, scanned: fetched } };
  },
  select: (pool, opts) => splitPool(pool.items, opts),
  meta: (pool) => ({
    source: {
      repo: pool.provenance.repo,
      commit: pool.provenance.commit,
      files: { "pseudocatalogue.csv": pool.provenance.files["pseudocatalogue.csv"] },
      worksScanned: pool.provenance.scanned,
      sampling: `pool: works that are not translations, title pointed, poetry first, in the order sha256("lumen-golden-v1:nikud:benyehuda:pool\\0<ID>"); ≤ 3 units per work and ≤ 6 per author, until ${POOL_TARGET} fully pointed sentences or verse lines (5–25 words) are found; dev and test drawn by splitPool. The text of each work is txt<path>.txt at the commit.`,
    },
    fields: { text: "the sentence with its nikud (the reference)", plain: "the same sentence without nikud (the input)", work: "the Ben-Yehuda work it comes from" },
    review: "pending: the owner proofreads the nikud (plan 15.11); fixes become a new version",
  }),
};

export const nakdimon = {
  /** Public pool: one fully pointed line (5–30 words) per file of tests/new/expected, chosen by a public hash. */
  pool(ctx) {
    const s = SRC.nakdimon;
    const paths = gitList(ctx.cache, s.repo, s.commit, "tests/new/expected");
    const items = [];
    for (const path of paths) {
      const text = fetchText(ctx.cache, rawUrl(s.repo, s.commit, path), { name: `nakdimon-${path.replace(/\W+/g, "_")}` });
      const lines = text.replace(/\r/g, "").split("\n");
      const cands = lines.map((t, i) => ({ id: String(i + 1), line: i + 1, t })).filter((x) => x.t === x.t.trim() && wordCount(x.t) >= 5 && wordCount(x.t) <= 30 && vocalisedShare(x.t) >= 0.6);
      if (!cands.length) continue;
      const c = shuffle(cands, `lumen-golden-v1:nikud:nakdimon:line:${path}`)[0];
      items.push({ id: `nak-${path.split("/").slice(3).join("-").replace(/\.txt$/, "")}`, genre: path.split("/")[3], path, line: c.line, fileSha256: sha256(text), text: c.t });
    }
    if (items.length < 80) throw new Error(`nakdimon: only ${items.length} files gave a line`);
    return { items, provenance: { repo: `https://github.com/${s.repo}`, commit: s.commit } };
  },
  select: (pool, opts) => splitPool(pool.items, opts),
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: one line per file of tests/new/expected (5–30 words, pointed), by sha256(\"lumen-golden-v1:nikud:nakdimon:line:<path>\\0<line>\"); dev and test drawn by splitPool" },
    fields: { path: "file in the repo at `commit`", line: "1-based line (one sentence per line); the text is that line", fileSha256: "sha256 of the whole file", sha256: "contentHash({text}) — scripts/lib/golden.mjs" },
  }),
};
