/**
 * The small golden sets of plan 7.10: one part each, built from public-domain
 * text in npm packages (@stdlib datasets: their contents are CC0 1.0), the
 * Crossmodal-3600 captions (GitHub) and generators / pools written for this
 * set (CC0 1.0). Every pool is public; the dev split is drawn with the
 * public seed and the test split with GOLDEN_SEED, as in plan 7.1. Where a
 * pool is a short hand-written list (summaries, citations, PDF questions)
 * the test split is the rest of the list, so the secret hides nothing:
 * SOURCES.md says so.
 *
 * Nothing here is fetched from a host the agent container cannot reach: the
 * npm registry and raw.githubusercontent.com only. Generated data is seeded,
 * so a rebuild reproduces a split byte for byte.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shuffle, splitPool, splitPoolWith } from "../../lib/golden.mjs";
import { parseCsv, pad } from "../common.mjs";
import { fetchCached, sha256 } from "../fetch.mjs";
import { SRC } from "../defs.mjs";
import { xm3600 } from "./caption.mjs";
import { SUMMARIES } from "./small/summaries.mjs";
import { PDF_DOCS, PDF_QUESTIONS } from "./small/pdfqa.mjs";
import { RECORDS } from "./small/citations.mjs";

// ── shared ──────────────────────────────────────────────────────────────

/** A deterministic PRNG in [0, 1) from a string seed. */
export function rng(seed) {
  let i = 0;
  return () => createHash("sha256").update(`${seed}\u0000${i++}`).digest().readUInt32BE(0) / 2 ** 32;
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const idOf = (prefix, s) => `${prefix}-${sha256(s).slice(0, 10)}`;

/** Files of a pinned npm tarball (SRC[key]: { npm, version, tgz }). */
function npmFiles(cache, key, paths) {
  const s = SRC[key];
  const base = s.npm.split("/").pop();
  const name = `${s.npm.replace(/\W+/g, "_")}-${s.version}.tgz`;
  fetchCached(join(cache, "npm"), `https://registry.npmjs.org/${s.npm}/-/${base}-${s.version}.tgz`, { sha: s.tgz, name });
  const tgz = join(cache, "npm", name);
  const out = {};
  for (const p of paths) {
    const r = spawnSync("tar", ["-xzOf", tgz, `package/${p}`], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${s.npm}@${s.version}: ${p} not in the tarball`);
    out[p] = r.stdout.toString("utf8");
  }
  return out;
}
const npmProvenance = (key, texts) => ({ package: `${SRC[key].npm}@${SRC[key].version}`, files: { [`${SRC[key].npm}-${SRC[key].version}.tgz`]: SRC[key].tgz, ...Object.fromEntries(Object.entries(texts).map(([p, t]) => [`package/${p}`, sha256(t)])) } });

const mobyChapters = (cache, from, to) => {
  const paths = [];
  for (let n = from; n <= to; n++) paths.push(`data/chapter_${n}.txt`);
  return npmFiles(cache, "moby", paths);
};
/** "CHAPTER 2. The Carpet-Bag.\n\npara\n\npara" → { title, paragraphs }. */
function chapter(text) {
  const [head, ...rest] = text.replace(/\r/g, "").split(/\n\s*\n/);
  const title = head.replace(/^CHAPTER \d+\.\s*/, "").replace(/\.$/, "").trim();
  return { title, paragraphs: rest.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean) };
}
const sentencesOf = (p) => p.split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.trim()).filter(Boolean);

// ── spell-en: synthetic noise on public-domain English ───────────────────

const KEYBOARD = (() => {
  const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  const near = {};
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      const n = [];
      for (const [dy, dx] of [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, -1]]) {
        const ch = rows[y + dy]?.[x + dx];
        if (ch) n.push(ch);
      }
      near[c] = n;
    }),
  );
  return near;
})();

function corrupt(word, kind, r) {
  const lower = word.toLowerCase();
  const i = 1 + Math.floor(r() * (word.length - 2)); // never the first letter
  const keepCase = (c, like) => (like === like.toUpperCase() ? c.toUpperCase() : c);
  switch (kind) {
    case "transposition":
      if (i + 1 >= word.length || lower[i] === lower[i + 1]) return null;
      return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    case "deletion":
      return word.slice(0, i) + word.slice(i + 1);
    case "doubling":
      return word.slice(0, i + 1) + word[i] + word.slice(i + 1);
    case "substitution": {
      const n = KEYBOARD[lower[i]];
      if (!n?.length) return null;
      return word.slice(0, i) + keepCase(pick(r, n), word[i]) + word.slice(i + 1);
    }
  }
  return null;
}

export const spellEn = {
  pool(ctx) {
    const texts = mobyChapters(ctx.cache, 42, 80);
    const vocab = new Map();
    const sentences = [];
    for (const t of Object.values(texts)) {
      for (const p of chapter(t).paragraphs) {
        for (const w of p.toLowerCase().match(/[a-z]+/g) ?? []) vocab.set(w, (vocab.get(w) ?? 0) + 1);
        for (const s of sentencesOf(p)) {
          const n = s.split(/\s+/).length;
          if (n >= 8 && n <= 30 && /^[\x20-\x7E—’‘“”]+$/.test(s)) sentences.push(s);
        }
      }
    }
    // Non-word errors only: a corruption must be neither a word of the chapters nor an English word.
    const words = npmFiles(ctx.cache, "words", ["index.json"]);
    const english = new Set(JSON.parse(words["index.json"]).map((w) => w.toLowerCase()));
    const unique = [...new Set(sentences)];
    return { items: unique.map((s) => ({ id: idOf("spell", s), text: s })), vocab, english, provenance: { ...npmProvenance("moby", texts), filter: npmProvenance("words", words) } };
  },
  select(pool, opts) {
    return splitPoolWith(pool.items, opts, (it, seed) => {
      const r = rng(`${seed}:${it.id}`);
      const words = [...it.text.matchAll(/[A-Za-z]{4,}/g)].filter((m) => (pool.vocab.get(m[0].toLowerCase()) ?? 0) >= 3);
      if (words.length < 2) return null;
      const n = r() < 0.7 ? 1 : 2;
      const chosen = shuffle(words.map((m, k) => ({ ...m, k, id: String(k) })), `${seed}:${it.id}:words`, (x) => x.id).slice(0, n).sort((a, b) => a.index - b.index);
      let noisy = "";
      let last = 0;
      const edits = [];
      for (const m of chosen) {
        const kind = pick(r, ["transposition", "deletion", "doubling", "substitution"]);
        const wrong = corrupt(m[0], kind, r);
        if (!wrong || wrong === m[0] || pool.vocab.has(wrong.toLowerCase()) || pool.english.has(wrong.toLowerCase())) return null; // must be a non-word
        noisy += it.text.slice(last, m.index);
        edits.push({ start: noisy.length, end: noisy.length + wrong.length, wrong, right: m[0], kind });
        noisy += wrong;
        last = m.index + m[0].length;
      }
      noisy += it.text.slice(last);
      return { id: it.id, noisy, clean: it.text, edits };
    });
  },
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: sentences of 8–30 words from Moby-Dick chapters 42–80; 1 (70%) or 2 errors each in words of ≥ 4 letters seen ≥ 3 times in those chapters; a corruption that is a word of the chapters or of an English word list (an-array-of-english-words, MIT, used as a filter only) is rejected — non-word errors only" },
    fields: { noisy: "the sentence with the injected errors", clean: "the original sentence", edits: "[{start, end (UTF-16 offsets in noisy), wrong, right, kind: transposition | deletion | doubling | substitution (QWERTY neighbour)}]" },
  }),
};

// ── image-search: Crossmodal-3600 captions as queries ────────────────────

export const imageSearch = {
  async pool(ctx) {
    const base = await xm3600.pool(ctx);
    return { ...base, items: base.items.map(({ refs_en, refs_he, ...it }) => ({ ...it, query: refs_en[0], query_he: refs_he[0] })) };
  },
  select: (pool, opts) => xm3600.select(pool, opts),
  finish: (items, ctx) => xm3600.finish(items, ctx),
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: every Crossmodal-3600 image with Hebrew and English captions and a CC BY 2.0 licence; half of each split from locale he (splitPool per stratum, seeds of this set — not caption's)" },
    fields: { query: "the first English caption, used as the search query", query_he: "the first Hebrew caption (the same query in Hebrew)", image: "the one relevant image (relative to the split folder; added where Open Images / Flickr are reachable)", corpus: "the split's own images: rank all of them for each query (nDCG@10, recall@1)", attribution: "CC BY 2.0 credit for the photo" },
    captionsLicense: "CC BY 4.0 (Google LLC)",
  }),
};

// ── clipper: static HTML pages with noise around the article ─────────────

const NOISE = {
  nav: () => `<nav class="site-nav"><a href="/">Home</a> <a href="/archive">Archive</a> <a href="/about">About us</a> <a href="/contact">Contact</a></nav>`,
  cookie: () => `<div class="cookie-banner" role="dialog"><p>We use cookies to improve your experience.</p><button>Accept all cookies</button></div>`,
  ad: (r) => `<aside class="ad"><span>Advertisement</span><p>Get ${10 + Math.floor(r() * 80)}% off premium harpoons this week only!</p></aside>`,
  share: () => `<div class="share"><a href="#">Share on Facebook</a> <a href="#">Share on X</a> <a href="#">Copy link</a></div>`,
  newsletter: () => `<form class="newsletter"><h3>Subscribe to our newsletter</h3><input type="email" placeholder="you@example.com"><button>Sign up</button></form>`,
  related: (r) => `<aside class="related"><h3>Related reading</h3><ul><li><a href="/p/${Math.floor(r() * 900 + 100)}">Ten knots every sailor should know</a></li><li><a href="/p/${Math.floor(r() * 900 + 100)}">The history of lighthouses</a></li></ul></aside>`,
  comments: () => `<section class="comments"><h3>3 comments</h3><div class="comment"><b>ahab_fan_77</b><p>Great post, thanks for sharing!</p></div></section>`,
  footer: (r, site) => `<footer><p>© ${2018 + Math.floor(r() * 8)} ${site}. All rights reserved.</p><a href="/privacy">Privacy policy</a></footer>`,
  breadcrumbs: () => `<ol class="breadcrumbs"><li><a href="/">Home</a></li><li><a href="/books">Books</a></li></ol>`,
  hidden: () => `<div style="display:none">Hidden tracking text that is never shown</div>`,
  script: () => `<script>window.dataLayer=window.dataLayer||[];dataLayer.push({event:"pageview"});</script><style>.ad{border:1px solid #ccc}</style>`,
};
const NOISE_TEXT = {
  nav: ["About us"],
  cookie: ["Accept all cookies", "We use cookies"],
  ad: ["Advertisement", "premium harpoons"],
  share: ["Share on Facebook"],
  newsletter: ["Subscribe to our newsletter"],
  related: ["Related reading", "Ten knots every sailor should know"],
  comments: ["Great post, thanks for sharing!"],
  footer: ["All rights reserved", "Privacy policy"],
  breadcrumbs: [],
  hidden: ["Hidden tracking text"],
  script: ["dataLayer"],
};
const LAYOUTS = ["blog", "news", "docs", "magazine", "minimal", "forum"];
const SITES = ["The Whaling Review", "Sea Stories Daily", "Old Books Online", "Nantucket Notes", "Harbour Readers", "Deep Blue Journal"];
const AUTHORS = ["Ada Pierce", "Jonah Starbuck", "Ruth Coffin", "Eli Macy", "Mira Gardner", "Tom Folger"];

/** Hebrew pages written for this set (CC0 1.0). */
const HE_PAGES = [
  { title: "איך מתחילים יומן אישי", paragraphs: ["יומן אישי הוא דרך פשוטה לעשות סדר במחשבות. אין צורך בכלים מיוחדים: מחברת, עט ועשר דקות בערב.", "כדאי לכתוב בכל יום באותה שעה, גם אם יש מעט מה לומר. ההרגל חשוב יותר מאורך הכתיבה.", "אחרי חודש אפשר לקרוא את הדפים הראשונים ולגלות דברים שכבר נשכחו."] },
  { title: "שלושה טיפים לגינה במרפסת", paragraphs: ["מרפסת קטנה יכולה להפוך לגינה ירוקה. בוחרים עציצים עם חורי ניקוז ואדמה איכותית.", "צמחי תבלין כמו נענע, בזיליקום ורוזמרין גדלים היטב גם בשמש חלקית.", "משקים בבוקר המוקדם, כדי שהמים לא יתאדו בחום של הצהריים."] },
  { title: "מדריך קצר לגיבוי קבצים", paragraphs: ["גיבוי טוב נשען על שלושה עותקים: שניים במקום אחד ואחד במקום אחר.", "כונן חיצוני מתאים לגיבוי שבועי, ושירות ענן מתאים לגיבוי אוטומטי של מסמכים חשובים.", "פעם בחודש כדאי לנסות לשחזר קובץ אחד, כדי לוודא שהגיבוי באמת עובד."] },
  { title: "סיור בשוק הכרמל", paragraphs: ["שוק הכרמל בתל אביב פתוח מהבוקר ועד אחר הצהריים, חוץ משבת.", "בכניסה מרחוב אלנבי יש דוכני פירות, ובהמשך הסמטאות נמצאים דוכני תבלינים ומאפים.", "מגיעים מוקדם כדי ליהנות מהשוק לפני העומס, ומביאים תיק בד לקניות."] },
  { title: "למה כדאי ללמוד לנגן", paragraphs: ["לימוד נגינה מפתח קשב, סבלנות וזיכרון. גם עשרים דקות ביום מביאות התקדמות.", "את הכלי הראשון כדאי לבחור לפי המוזיקה שאוהבים לשמוע.", "מורה טוב עוזר להימנע מהרגלים שקשה לתקן אחר כך."] },
  { title: "ארוחת בוקר ישראלית", paragraphs: ["ארוחת בוקר ישראלית כוללת בדרך כלל ביצים, סלט ירקות קצוץ, גבינות ולחם טרי.", "הסלט נחתך לקוביות קטנות ומתובל בשמן זית, לימון ומלח.", "בבתי מלון רבים מגישים גם שקשוקה, דגים מעושנים ומיצים סחוטים."] },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderPage(page, r) {
  const layout = pick(r, LAYOUTS);
  const site = pick(r, SITES);
  const author = page.lang === "he" ? "דנה לוי" : pick(r, AUTHORS);
  const noise = shuffle(Object.keys(NOISE), `${page.id}:noise:${r()}`, (x) => x).slice(0, 4 + Math.floor(r() * 5));
  const before = noise.filter((n) => ["nav", "cookie", "breadcrumbs", "script"].includes(n));
  const inside = noise.filter((n) => ["ad", "share"].includes(n));
  const after = noise.filter((n) => !before.includes(n) && !inside.includes(n));
  const paras = page.paragraphs.map((p) => `<p>${esc(p)}</p>`);
  if (page.subheading) paras.splice(page.subheading.at, 0, `<h2>${esc(page.subheading.title)}</h2>`);
  // An ad or share bar between paragraphs, as real pages do.
  if (inside.length && paras.length > 2) paras.splice(1 + Math.floor(r() * (paras.length - 1)), 0, ...inside.map((n) => NOISE[n](r, site)));
  else after.unshift(...inside);
  const dir = page.lang === "he" ? ' dir="rtl"' : "";
  const article = {
    blog: () => `<article class="post"><header><h1>${esc(page.title)}</h1><p class="byline">By ${esc(author)}</p></header>${paras.join("")}</article>`,
    news: () => `<main><div class="story"><h1 class="headline">${esc(page.title)}</h1><div class="meta"><span class="author">${esc(author)}</span></div><div class="story-body">${paras.join("")}</div></div></main>`,
    docs: () => `<div class="layout"><div class="sidebar"><ul><li><a href="#a">Introduction</a></li><li><a href="#b">Chapters</a></li></ul></div><div class="content"><h1>${esc(page.title)}</h1>${paras.join("")}</div></div>`,
    magazine: () => `<div id="page"><div class="hero"><h1>${esc(page.title)}</h1></div><div class="columns"><div class="col-main">${paras.join("")}</div></div></div>`,
    minimal: () => `<h1>${esc(page.title)}</h1>${paras.join("\n")}`,
    forum: () => `<div class="thread"><h1 class="thread-title">${esc(page.title)}</h1><div class="post first-post"><div class="post-author">${esc(author)}</div><div class="post-body">${paras.join("")}</div></div></div>`,
  }[layout]();
  const html = `<!doctype html>\n<html lang="${page.lang}"${dir}>\n<head>\n<meta charset="utf-8">\n<title>${esc(page.title)} — ${esc(site)}</title>\n<meta name="author" content="${esc(author)}">\n</head>\n<body>\n${before.map((n) => NOISE[n](r, site)).join("\n")}\n${article}\n${after.map((n) => NOISE[n](r, site)).join("\n")}\n</body>\n</html>\n`;
  return { html, layout, site, author, noise };
}

export const clipper = {
  pool(ctx) {
    const texts = mobyChapters(ctx.cache, 2, 41);
    const items = Object.entries(texts).map(([path, t]) => {
      const c = chapter(t);
      const n = Number(/chapter_(\d+)/.exec(path)[1]);
      return { id: `clip-moby-${pad(n)}`, lang: "en", title: c.title, paragraphs: c.paragraphs.slice(0, 6), source: `Moby-Dick, chapter ${n}` };
    });
    HE_PAGES.forEach((p, i) => items.push({ id: `clip-he-${pad(i + 1)}`, lang: "he", title: p.title, paragraphs: p.paragraphs, source: "written for this set" }));
    return { items, provenance: npmProvenance("moby", texts) };
  },
  select(pool, opts) {
    return splitPoolWith(pool.items, opts, (page, seed) => {
      const r = rng(`${seed}:${page.id}`);
      const withSub = page.paragraphs.length >= 4 && r() < 0.4 ? { title: page.lang === "he" ? "ועוד דבר אחד" : "Further on", at: 2 + Math.floor(r() * (page.paragraphs.length - 2)) } : null;
      const p = { ...page, subheading: withSub };
      const rendered = renderPage(p, r);
      return {
        id: page.id,
        file: `clipper/${page.id}.html`,
        lang: page.lang,
        layout: rendered.layout,
        expected: {
          title: page.title,
          author: rendered.author,
          headings: withSub ? [withSub.title] : [],
          paragraphs: page.paragraphs,
          mustInclude: [page.paragraphs[0].slice(0, 80), page.paragraphs[page.paragraphs.length - 1].slice(-80)],
          mustExclude: rendered.noise.flatMap((n) => NOISE_TEXT[n]).concat(rendered.site ? [` — ${rendered.site}`] : []),
        },
        source: page.source,
        _html: rendered.html,
      };
    });
  },
  finish(items, { splitDir, split, manifest }) {
    // Each page carries its split's canary, like the JSON files.
    const canary = split === "dev" ? manifest.canary : manifest.test.canary;
    const out = items.map(({ _html, ...it }) => {
      mkdirSync(dirname(join(splitDir, it.file)), { recursive: true });
      writeFileSync(join(splitDir, it.file), _html.replace("<!doctype html>\n", `<!doctype html>\n<!-- ${canary} -->\n`));
      return it;
    });
    return { items: out, complete: true };
  },
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: the first paragraphs of Moby-Dick chapters 2–41 and 6 Hebrew pages written for this set; each split's seed picks the pages, the layout, the site name, the noise blocks (navigation, cookie banner, ads, share bar, newsletter, related links, comments, footer, hidden text, scripts) and an optional sub-heading" },
    fields: { file: "the saved page (static HTML, relative to the split folder)", expected: "title, author, headings, the article's paragraphs in order, mustInclude (start and end of the article), mustExclude (text of the noise blocks — none may appear in the clip)", layout: "which page template wraps the article" },
  }),
};

// ── pdf-qa: three public-domain documents as PDFs, 30 questions ──────────

const WINANSI = { "—": 0x97, "–": 0x96, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "…": 0x85, "•": 0x95 };
function pdfString(s) {
  let out = "(";
  for (const ch of s) {
    let code = WINANSI[ch] ?? ch.codePointAt(0);
    if (code > 255) code = 0x3f; // "?" — the documents are Latin-1 apart from the mapped punctuation
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (code < 32 || code > 126) out += "\\" + code.toString(8).padStart(3, "0");
    else out += String.fromCharCode(code);
  }
  return out + ")";
}
function wrap(text, width) {
  const lines = [];
  for (const para of text.split(/\n\s*\n/)) {
    let line = "";
    for (const w of para.replace(/\s+/g, " ").trim().split(" ")) {
      if (line && (line + " " + w).length > width) {
        lines.push(line);
        line = w;
      } else line = line ? `${line} ${w}` : w;
    }
    if (line) lines.push(line);
    lines.push("");
  }
  return lines;
}
/** A deterministic text-only PDF 1.4 (Courier 10 pt, US Letter), no timestamps. */
export function textPdf(title, text, canary = "") {
  const lines = [title, "", ...wrap(text, 84)];
  const perPage = 58;
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const page of pages) {
    const ops = ["BT", "/F1 10 Tf", "12 TL", "54 738 Td", ...page.map((l) => `${pdfString(l)} '`), "ET"].join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfString(title)}${canary ? ` /Subject ${pdfString(canary)}` : ""} /Producer (Lumen golden sets) >>`);
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const pdfQa = {
  pool(ctx) {
    const sotu = npmFiles(ctx.cache, "sotu", PDF_DOCS.filter((d) => d.pkg === "sotu").map((d) => d.file));
    const moby = npmFiles(ctx.cache, "moby", PDF_DOCS.filter((d) => d.pkg === "moby").map((d) => d.file));
    const docs = PDF_DOCS.map((d) => {
      const raw = (d.pkg === "sotu" ? sotu : moby)[d.file];
      // Paragraphs where the source has them (Moby-Dick), else one block.
      const text = raw.replace(/\r/g, "").replace(/^CHAPTER 1\. Loomings\.\s*/, "").trim();
      return { id: d.id, title: d.title, text, file: `pdf-qa/${d.id}.pdf` };
    });
    const flat = (t) => t.replace(/\s+/g, " ");
    const items = PDF_QUESTIONS.map(([doc, question, answer, alt = []], i) => {
      const d = docs.find((x) => x.id === doc);
      if (!flat(d.text).includes(answer)) throw new Error(`pdf-qa: answer of question ${i + 1} is not in ${doc}`);
      return { id: `pdfq-${pad(i + 1, 2)}`, doc, file: d.file, question, answer, alt };
    });
    pdfQa._docs = docs; // finish() writes these PDFs into each split
    return { items, docs, provenance: { ...npmProvenance("sotu", sotu), moby: npmProvenance("moby", moby) } };
  },
  select: (pool, opts) => splitPool(pool.items, opts),
  finish(items, { splitDir, split, manifest }) {
    const canary = split === "dev" ? manifest.canary : manifest.test.canary;
    for (const d of pdfQa._docs ?? []) {
      mkdirSync(dirname(join(splitDir, d.file)), { recursive: true });
      writeFileSync(join(splitDir, d.file), textPdf(d.title, d.text, canary));
    }
    return { items, complete: true };
  },
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: 30 questions written for this set (10 per document); the test split is the 22 not in dev — the secret hides nothing here, the pool is the set" },
    fields: { doc: "document id (see `documents`)", file: "the document as a PDF (relative to the split folder)", question: "the question", answer: "a span of the document that answers it", alt: "other acceptable answers", documents: "id, title, PDF path and plain text of each document" },
  }),
  extra: (pool) => ({ documents: pool.docs }),
};

// ── data-analysis: questions over Nightingale's rose (1854–1856) ─────────

export const dataAnalysis = {
  pool(ctx) {
    const files = npmFiles(ctx.cache, "rose", ["data/data.csv"]);
    const csv = files["data/data.csv"];
    const rows = parseCsv(csv).map((r) => ({ month: r.date.slice(0, 7), army: Number(r.army_size), disease: Number(r.disease), wounds: Number(r.wounds), other: Number(r.other) }));
    if (rows.length !== 24) throw new Error(`data-analysis: ${rows.length} rows, want 24`);
    const causes = ["disease", "wounds", "other"];
    const label = { disease: "zymotic (preventable) disease", wounds: "wounds and injuries", other: "all other causes" };
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const r1 = (x) => Math.round(x * 10) / 10;
    const items = [];
    const q = (key, question, answer, extra = {}) => items.push({ id: `rose-${key}`, question, answer, ...extra });
    for (const c of causes)
      for (const y of ["1854", "1855", "1856"]) q(`total-${c}-${y}`, `How many deaths from ${label[c]} were recorded in ${y}?`, sum(rows.filter((r) => r.month.startsWith(y)).map((r) => r[c])), { kind: "sum" });
    for (const c of causes) {
      const max = Math.max(...rows.map((r) => r[c]));
      const at = rows.filter((r) => r[c] === max);
      if (at.length === 1) q(`max-${c}`, `In which month (YYYY-MM) were deaths from ${label[c]} highest?`, at[0].month, { kind: "argmax" });
    }
    for (const y of ["1854", "1855", "1856"]) q(`army-${y}`, `What was the average army size in ${y}, rounded to the nearest whole number?`, Math.round(sum(rows.filter((r) => r.month.startsWith(y)).map((r) => r.army)) / rows.filter((r) => r.month.startsWith(y)).length), { kind: "mean" });
    for (const r of rows.filter((_, i) => i % 4 === 0)) for (const c of causes) q(`rate-${c}-${r.month}`, `What was the annual mortality rate per 1,000 from ${label[c]} in ${r.month} (deaths × 12 × 1000 / army size), to one decimal?`, r1((r[c] * 12 * 1000) / r.army), { kind: "rate", tolerance: 0.05 });
    for (const t of [500, 1000, 2000]) q(`count-disease-${t}`, `In how many months were there more than ${t} deaths from ${label.disease}?`, rows.filter((r) => r.disease > t).length, { kind: "count" });
    q("share-disease", "What percentage of all recorded deaths were from zymotic disease, to one decimal?", r1((100 * sum(rows.map((r) => r.disease))) / sum(rows.map((r) => r.disease + r.wounds + r.other))), { kind: "share", tolerance: 0.05 });
    q("total-all", "How many deaths were recorded in total, from all causes, over the whole period?", sum(rows.map((r) => r.disease + r.wounds + r.other)), { kind: "sum" });
    q("wounds-over-disease", "In how many months were deaths from wounds and injuries higher than deaths from disease?", rows.filter((r) => r.wounds > r.disease).length, { kind: "count" });
    let best = null;
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].disease - rows[i - 1].disease;
      if (!best || d > best.d) best = { d, month: rows[i].month };
    }
    q("jump-disease", "In which month (YYYY-MM) did deaths from disease rise the most compared with the month before?", best.month, { kind: "argmax" });
    return { items, csv, provenance: npmProvenance("rose", files) };
  },
  select: (pool, opts) => splitPool(pool.items, opts),
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: questions generated from templates over the 24 monthly rows (sums, means, maxima, Nightingale's annual rate per 1,000, counts); answers computed from the CSV by the builder" },
    fields: { table: "the CSV, verbatim from the package ({name, csv}); a harness writes it to a file for the tool under test: date, army_size, disease, wounds, other — monthly deaths of the British army in the East, April 1854 – March 1856", question: "the question", answer: "number or YYYY-MM", tolerance: "allowed absolute error for decimals (else exact)", kind: "sum | mean | argmax | rate | count | share" },
  }),
  extra: (pool) => ({ table: { name: "nightingales-rose.csv", csv: pool.csv } }),
};

// ── summarize: 20 openings of State of the Union addresses ───────────────

/** The address without its salutation, its first sentences up to 170 words. */
export function sotuExcerpt(raw) {
  const t = raw.replace(/\s+/g, " ").trim().replace(/^(?:(?:To the|Gentlemen|Fellow|Mr\.|Mr\. President|Mr\. Speaker)[^:]{0,240}):\s*/, "");
  const out = [];
  let w = 0;
  for (const s of t.split(/(?<=[.!?])\s+(?=[A-Z[])/)) {
    if (w >= 170) break;
    out.push(s);
    w += s.split(" ").length;
  }
  return out.join(" ");
}

export const summarize = {
  pool(ctx) {
    const texts = npmFiles(ctx.cache, "sotu", SUMMARIES.map((s) => `data/${s.file}.txt`));
    const items = SUMMARIES.map((s) => {
      const document = sotuExcerpt(texts[`data/${s.file}.txt`]);
      for (const k of s.keywords) if (!document.toLowerCase().includes(k.toLowerCase())) throw new Error(`summarize: keyword "${k}" is not in ${s.file}`);
      const [year, ...name] = s.file.split("_");
      return { id: `sum-${year}`, document, source: { address: `State of the Union, ${year}`, president: name.slice(0, -1).map((x) => x[0].toUpperCase() + x.slice(1)).join(" "), file: `data/${s.file}.txt` }, reference: s.summary, keywords: s.keywords };
    });
    return { items, provenance: npmProvenance("sotu", texts) };
  },
  select: (pool, opts) => splitPool(pool.items, opts),
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: the opening (≤ ~200 words, salutation removed) of 20 addresses, one per decade or so from 1790 to 2005; reference summaries and key words written for this set — the test split is the 15 not in dev (the pool is the set)" },
    fields: { document: "the text to summarise", reference: "a reference summary (1–2 sentences)", keywords: "key words a faithful summary should carry (each occurs in the document)", source: "which address" },
  }),
};

// ── formulas: database formulas over one row ─────────────────────────────

const HE_FIRST = ["דנה", "יוסי", "מיכל", "אבי", "נועה", "רון"];
const HE_LAST = ["כהן", "לוי", "מזרחי", "פרץ", "ביטון", "אברהם"];
const EN_FIRST = ["Ada", "Ben", "Chloe", "David", "Eva", "Felix"];
const EN_LAST = ["Stone", "Rivers", "Park", "Hale", "Moss", "Grant"];
const iso = (d) => d.toISOString().slice(0, 10);
const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
function monthsBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  let m = (ay - by) * 12 + (am - bm);
  if (m > 0 && ad < bd) m--;
  if (m < 0 && ad > bd) m++;
  return m;
}
/** Round half away from zero on an integer numerator / 10^scale, to `digits` decimals. */
function roundScaled(num, scale, digits) {
  const div = 10 ** (scale - digits);
  const q = Math.floor(Math.abs(num) / div) + (Math.abs(num) % div >= div / 2 ? 1 : 0);
  return (Math.sign(num) * q) / 10 ** digits;
}

const FORMULAS = [
  ["product", () => ({}), (r) => ({ row: { Price: r.price, Qty: r.qty }, f: 'prop("Price") * prop("Qty")', v: roundScaled(r.price100 * r.qty, 2, 2) })],
  ["vat", () => ({}), (r) => ({ row: { Price: r.price, Qty: r.qty }, f: 'round(prop("Price") * prop("Qty") * 1.17, 2)', v: roundScaled(r.price100 * r.qty * 117, 4, 2) })],
  ["if-done", () => ({}), (r) => ({ row: { Done: r.bool }, f: 'if(prop("Done"), "✓", "✗")', v: r.bool ? "✓" : "✗" })],
  ["full-name", () => ({}), (r) => ({ row: { First: r.first, Last: r.last }, f: 'concat(prop("First"), " ", prop("Last"))', v: `${r.first} ${r.last}` })],
  ["length", () => ({}), (r) => ({ row: { Title: r.title }, f: 'length(prop("Title"))', v: [...r.title].length })],
  ["upper", () => ({}), (r) => ({ row: { Code: r.code }, f: 'upper(prop("Code"))', v: r.code.toUpperCase() })],
  ["days-between", () => ({}), (r) => ({ row: { Start: r.start, Due: r.due }, f: 'dateBetween(prop("Due"), prop("Start"), "days")', v: days(r.due, r.start) })],
  ["pass", () => ({}), (r) => ({ row: { Score: r.score }, f: 'prop("Score") >= 60', v: r.score >= 60 })],
  ["discount", () => ({}), (r) => ({ row: { Price: r.price, Qty: r.qty }, f: 'if(prop("Qty") > 10, prop("Price") * 0.9, prop("Price"))', v: r.qty > 10 ? roundScaled(r.price100 * 9, 3, 3) : r.price })],
  ["max", () => ({}), (r) => ({ row: { A: r.a, B: r.b, C: r.c }, f: 'max(prop("A"), prop("B"), prop("C"))', v: Math.max(r.a, r.b, r.c) })],
  ["min", () => ({}), (r) => ({ row: { A: r.a, B: r.b, C: r.c }, f: 'min(prop("A"), prop("B"), prop("C"))', v: Math.min(r.a, r.b, r.c) })],
  ["abs-diff", () => ({}), (r) => ({ row: { A: r.a, B: r.b }, f: 'abs(prop("A") - prop("B"))', v: Math.abs(r.a - r.b) })],
  ["hours", () => ({}), (r) => ({ row: { Minutes: r.minutes }, f: 'floor(prop("Minutes") / 60)', v: Math.floor(r.minutes / 60) })],
  ["mod", () => ({}), (r) => ({ row: { Minutes: r.minutes }, f: 'mod(prop("Minutes"), 60)', v: r.minutes % 60 })],
  ["contains", () => ({}), (r) => ({ row: { Tags: r.tags }, f: 'contains(prop("Tags"), "urgent")', v: r.tags.includes("urgent") })],
  ["not", () => ({}), (r) => ({ row: { Done: r.bool }, f: 'not prop("Done")', v: !r.bool })],
  ["and", () => ({}), (r) => ({ row: { Done: r.bool, Qty: r.qty0 }, f: 'prop("Done") and prop("Qty") > 0', v: r.bool && r.qty0 > 0 })],
  ["label", () => ({}), (r) => ({ row: { Title: r.title, Qty: r.qty }, f: 'concat(prop("Title"), " (", prop("Qty"), ")")', v: `${r.title} (${r.qty})` })],
  // score / 120 * 100 = score * 5 / 6, rounded half up to 1 decimal: exact integer arithmetic.
  ["percent", () => ({}), (r) => ({ row: { Score: r.score, Max: 120 }, f: 'round(prop("Score") / prop("Max") * 100, 1)', v: Math.floor((100 * r.score + 6) / 12) / 10 })],
  ["empty", () => ({}), (r) => ({ row: { Note: r.note }, f: 'if(empty(prop("Note")), "—", prop("Note"))', v: r.note === "" ? "—" : r.note })],
  ["months-between", () => ({}), (r) => ({ row: { Start: r.start, End: r.end }, f: 'dateBetween(prop("End"), prop("Start"), "months")', v: monthsBetween(r.end, r.start) })],
  ["lower", () => ({}), (r) => ({ row: { Email: r.email }, f: 'lower(prop("Email"))', v: r.email.toLowerCase() })],
  ["to-number", () => ({}), (r) => ({ row: { Text: String(r.a) }, f: 'toNumber(prop("Text")) + 1', v: r.a + 1 })],
  ["unit-price", () => ({}), (r) => ({ row: { Total: r.total, Qty: r.qty }, f: 'round(prop("Total") / prop("Qty"), 2)', v: Math.floor((2 * r.total100 + r.qty) / (2 * r.qty)) / 100 })],
  ["status", () => ({}), (r) => ({ row: { Status: r.status }, f: 'if(prop("Status") == "Done", 1, 0)', v: r.status === "Done" ? 1 : 0 })],
  ["pages", () => ({}), (r) => ({ row: { Pages: r.pages }, f: 'ceil(prop("Pages") / 20)', v: Math.ceil(r.pages / 20) })],
  ["len-concat", () => ({}), (r) => ({ row: { First: r.first, Last: r.last }, f: 'length(concat(prop("First"), prop("Last")))', v: [...r.first].length + [...r.last].length })],
  ["precedence", () => ({}), (r) => ({ row: { A: r.a, B: r.b, C: r.c }, f: 'prop("A") + prop("B") * prop("C")', v: r.a + r.b * r.c })],
  ["parens", () => ({}), (r) => ({ row: { A: r.a, B: r.b, C: r.c }, f: '(prop("A") + prop("B")) * prop("C")', v: (r.a + r.b) * r.c })],
  ["years-between", () => ({}), (r) => ({ row: { Start: r.start, End: r.end }, f: 'dateBetween(prop("End"), prop("Start"), "years")', v: Math.trunc(monthsBetween(r.end, r.start) / 12) })],
];

function formulaRow(seed) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const he = r() < 0.4;
  const price100 = int(100, 99999);
  const qty = int(1, 25);
  const start = new Date(Date.UTC(int(2020, 2026), int(0, 11), int(1, 28)));
  const due = new Date(start.getTime() + int(1, 400) * 86_400_000);
  const end = new Date(Date.UTC(start.getUTCFullYear() + int(0, 6), int(0, 11), int(1, 28)));
  const total100 = int(100, 500000);
  return {
    price100, price: price100 / 100, qty, qty0: int(0, 3), bool: r() < 0.5,
    first: pick(r, he ? HE_FIRST : EN_FIRST), last: pick(r, he ? HE_LAST : EN_LAST),
    title: pick(r, he ? ["דוח רבעוני", "תוכנית עבודה", "פגישת צוות", "רשימת קניות"] : ["Quarterly report", "Work plan", "Team meeting", "Shopping list"]),
    code: pick(r, ["abc-12", "lumen", "q3-plan", "x7"]), start: iso(start), due: iso(due), end: iso(end < start ? start : end),
    score: int(0, 120), a: int(-50, 200), b: int(-50, 200), c: int(1, 20), minutes: int(0, 1000),
    tags: pick(r, ["urgent, work", "home", "work, later", "urgent", "", "not-urgent"]), note: pick(r, ["", "", "check with Dana", "בדיקה חוזרת"]),
    email: pick(r, ["Dana.Levi@Example.com", "BEN@lumen.APP", "info@Example.org"]), total100, total: total100 / 100, status: pick(r, ["Done", "In progress", "Todo"]), pages: int(1, 300),
  };
}

export const formulas = {
  pool() {
    const items = [];
    for (const [key] of FORMULAS) for (let v = 1; v <= 3; v++) items.push({ id: `fx-${key}-${v}`, key, variant: v });
    return { items };
  },
  select(pool, opts) {
    return splitPoolWith(pool.items, opts, (it, seed) => {
      const t = FORMULAS.find(([k]) => k === it.key);
      const { row, f, v } = t[2](formulaRow(`${seed}:${it.id}`));
      return { id: it.id, formula: f, row, expected: v, type: typeof v === "boolean" ? "boolean" : typeof v === "number" ? "number" : "string" };
    });
  },
  meta: () => ({
    source: { sampling: "30 formula templates written for this set (CC0 1.0), 3 slots each; the split's seed fills the row (numbers, dates, English or Hebrew strings); expected values computed by the builder with exact decimal arithmetic" },
    fields: {
      formula: 'a Notion-style formula: prop("Name"), numbers, "strings", + - * /, comparisons (== != > < >= <=), and / or / not, parentheses; functions round(x, n) (half away from zero), floor, ceil, abs, min, max, mod, concat (numbers as written), length (code points), upper, lower, contains, empty, if(c, a, b), toNumber, dateBetween(a, b, "days" | "months" | "years") (whole units, a − b)',
      row: "the row's property values (dates as YYYY-MM-DD)",
      expected: "the formula's value",
      type: "number | string | boolean",
    },
  }),
};

// ── unlinked-mentions: titles mentioned without [[links]] ────────────────

const TITLES = ["Project Phoenix", "Weekly Review", "Tel Aviv", "Reading List", "Docker", "API Design", "Q3 Goals", "Garden Plan", "תל אביב", "רשימת קניות", "פגישת צוות", "מתכון עוגה", "דנה כהן", "יומן"];
const HE_PREFIX = ["ו", "ה", "ב", "ל", "מ", "ש", "כ", "וב", "של"];
const isHe = (s) => /[֐-׿]/.test(s);

/** One fragment: text, and the mentions in it (offsets within the fragment). */
function fragment(kind, title, r) {
  const he = isHe(title);
  const pre = he ? pick(r, HE_PREFIX) : "";
  const say = (before, after, prefix = "") => {
    const start = before.length + prefix.length;
    return { text: `${before}${prefix}${title}${after}`, mentions: [{ start, end: start + title.length, target: title, ...(prefix ? { prefix } : {}) }] };
  };
  switch (kind) {
    case "plain":
      return he ? say("אתמול דיברנו על ", " בפגישה.") : say("We talked about ", " yesterday.");
    case "lower":
      return he ? say("כתבתי עוד הערה על ", ".") : { text: `see the ${title.toLowerCase()} notes`, mentions: [{ start: 8, end: 8 + title.length, target: title }] };
    case "prefix":
      return he ? say("נפגשנו ", " אחרי העבודה.", pre) : say("Notes on ", ", part two.");
    case "start":
      return he ? say("", " עדיין לא מוכן.") : say("", " is still open.");
    case "linked":
      return { text: he ? `ראו [[${title}]] למעלה.` : `See [[${title}]] above.`, mentions: [] };
    case "alias":
      return { text: he ? `ראו [[${title}|כאן]].` : `See [[${title}|here]].`, mentions: [] };
    case "code":
      return { text: `\`${title}\` is a code span here.`, mentions: [] };
    case "url":
      return { text: `https://example.com/${encodeURIComponent(title)}/x`, mentions: [] };
    case "md-link":
      return { text: `[${title}](https://example.com) is already a link.`, mentions: [] };
    case "inside-word":
      return he ? { text: `${title}ים רבים`, mentions: [] } : { text: `${title}s and more ${title.replace(/\s/g, "")}x`, mentions: [] };
    default:
      throw new Error(kind);
  }
}
const POSITIVE = ["plain", "lower", "prefix", "start"];
const NEGATIVE = ["linked", "alias", "code", "url", "md-link", "inside-word"];

export const unlinkedMentions = {
  pool() {
    const items = [];
    for (let i = 1; i <= 90; i++) items.push({ id: `um-${pad(i, 2)}` });
    return { items };
  },
  select(pool, opts) {
    return splitPoolWith(pool.items, opts, (it, seed) => {
      const r = rng(`${seed}:${it.id}`);
      const self = pick(r, TITLES);
      const others = TITLES.filter((t) => t !== self);
      const kinds = [pick(r, POSITIVE), pick(r, NEGATIVE), r() < 0.6 ? pick(r, POSITIVE) : pick(r, NEGATIVE)];
      if (r() < 0.3) kinds.push("self");
      let text = `# ${self}\n\n`;
      const mentions = [];
      for (const kind of shuffle(kinds, `${seed}:${it.id}:order`, (k) => k + Math.floor(r() * 1e9))) {
        if (kind === "self") {
          text += `${isHe(self) ? "הפתק הזה הוא" : "This note is"} ${self}.\n\n`; // a note never links to itself
          continue;
        }
        const title = pick(r, others);
        const f = fragment(kind, title, r);
        for (const m of f.mentions) mentions.push({ ...m, start: m.start + text.length, end: m.end + text.length, text: (text + f.text).slice(m.start + text.length, m.end + text.length) });
        text += f.text + "\n\n";
      }
      // Lowercase mentions keep the title's own text out of `text`: check every span.
      for (const m of mentions) if (m.text.toLowerCase() !== m.target.toLowerCase()) return null;
      return { id: it.id, title: self, text: text.trimEnd() + "\n", titles: TITLES, mentions };
    });
  },
  meta: () => ({
    source: { sampling: "90 slots; each split's seed writes a note from fragments written for this set (CC0 1.0): mentions in plain text, lower case, Hebrew with a one- or two-letter prefix (ו ה ב ל מ ש כ וב של), at the start of a line; and cases that are not unlinked mentions: [[links]], aliased links, code spans, URLs, Markdown link text, a title inside a longer word, the note's own title" },
    fields: { title: "the note's own title (never a mention target)", text: "the note (Markdown)", titles: "every note title in the vault", mentions: "[{start, end (UTF-16 offsets of the title in text, prefix excluded), text, target, prefix?}] — case-insensitive for Latin titles, whole words only, longest title first" },
  }),
};

// ── bidi: line direction for Hebrew / English / neutral text ─────────────

const RTL_CH = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CH = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿가-힯]/;
/** UAX #9 P2–P3 on the text after Markdown markers (# - * > 1. [ ] ** ` and link URLs); RLM/LRM count as strong. */
export function lineDir(line) {
  const t = line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/`[^`]*`/g, "");
  for (const ch of t) {
    if (ch === "‏") return "rtl";
    if (ch === "‎") return "ltr";
    if (RTL_CH.test(ch)) return "rtl";
    if (LTR_CH.test(ch)) return "ltr";
  }
  return "neutral";
}

const BIDI_PARTS = {
  he: ["שלום לכולם", "הפגישה נדחתה", "קניתי חלב ולחם", "המצגת מוכנה", "נדבר מחר בבוקר", "תזכורת חשובה"],
  en: ["Hello everyone", "The meeting moved", "Buy milk and bread", "The deck is ready", "Talk tomorrow", "Important reminder"],
  ar: ["مرحبا بالجميع", "الاجتماع غدا"],
  neutral: ["10:30", "2026-10-18", "+972-50-1234567", "42%", "😀", "…", "(3)", "#1"],
  tokens: ["PDF", "GitHub", "Dana", "CEO", "Q3", "iPhone", "README.md", "https://example.com/a"],
};
const MD_PREFIX = ["", "", "# ", "## ", "- ", "* ", "1. ", "> ", "- [ ] ", "- [x] "];

export const bidi = {
  pool() {
    const items = [];
    for (let i = 1; i <= 90; i++) items.push({ id: `bidi-${pad(i, 2)}` });
    return { items };
  },
  select(pool, opts) {
    return splitPoolWith(pool.items, opts, (it, seed) => {
      const r = rng(`${seed}:${it.id}`);
      const shape = pick(r, ["he", "en", "he-en", "en-he", "neutral-he", "neutral-en", "neutral", "token-he", "ar", "mark", "link-he", "code-en"]);
      const he = pick(r, BIDI_PARTS.he);
      const en = pick(r, BIDI_PARTS.en);
      const n = pick(r, BIDI_PARTS.neutral);
      const tok = pick(r, BIDI_PARTS.tokens);
      const body = {
        he: he,
        en: en,
        "he-en": `${he} ${tok}`,
        "en-he": `${en} ${he}`,
        "neutral-he": `${n} ${he}`,
        "neutral-en": `${n} ${en}`,
        neutral: `${n} ${pick(r, BIDI_PARTS.neutral)}`,
        "token-he": `${tok} ${he}`,
        ar: pick(r, BIDI_PARTS.ar),
        mark: `‏${n} ${tok}`,
        "link-he": `[${he}](https://example.com/${tok.replace(/\W/g, "")})`,
        "code-en": `\`${tok}\` ${pick(r, [en, he])}`,
      }[shape];
      const line = pick(r, MD_PREFIX) + body;
      return { id: it.id, line, dir: lineDir(line), shape };
    });
  },
  meta: () => ({
    source: { sampling: "90 slots; each split's seed composes a line from fragments written for this set (CC0 1.0): Hebrew, English, Arabic, neutral runs (times, dates, phone numbers, emoji, punctuation), Latin tokens inside Hebrew, RLM, links and code, behind Markdown markers" },
    fields: { line: "one line of Markdown", dir: "rtl | ltr | neutral — the first strong character (UAX #9 P2–P3) after Markdown markers; link URLs and code spans do not count; U+200F / U+200E count as strong", shape: "how the line was composed" },
  }),
};

// ── hebrew-dates: Gregorian ↔ Hebrew calendar ────────────────────────────

const HEB_MONTH = { Tishri: "תשרי", Heshvan: "חשוון", Kislev: "כסלו", Tevet: "טבת", Shevat: "שבט", "Adar I": "אדר א׳", Adar: "אדר", "Adar II": "אדר ב׳", Nisan: "ניסן", Iyar: "אייר", Sivan: "סיוון", Tamuz: "תמוז", Av: "אב", Elul: "אלול" };
const LETTERS = [[400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"], [90, "צ"], [80, "פ"], [70, "ע"], [60, "ס"], [50, "נ"], [40, "מ"], [30, "ל"], [20, "כ"], [10, "י"], [9, "ט"], [8, "ח"], [7, "ז"], [6, "ו"], [5, "ה"], [4, "ד"], [3, "ג"], [2, "ב"], [1, "א"]];
/** Hebrew numerals with geresh / gershayim, 15 → ט״ו, 16 → ט״ז (years without the thousands). */
export function gematria(n) {
  let s = "";
  let rest = n;
  while (rest > 0) {
    if (rest === 15 || rest === 16) {
      s += rest === 15 ? "טו" : "טז";
      break;
    }
    const [v, l] = LETTERS.find(([v]) => v <= rest);
    s += l;
    rest -= v;
  }
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}
const ICU_HE = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export function hebrewDate(isoDate) {
  const parts = Object.fromEntries(ICU_HE.formatToParts(new Date(`${isoDate}T12:00:00Z`)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const day = Number(parts.day);
  const year = Number(parts.year);
  const month = parts.month;
  if (!HEB_MONTH[month]) throw new Error(`hebrew-dates: unknown month ${month}`);
  return { day, month, monthHe: HEB_MONTH[month], year, text: `${gematria(day)} ב${HEB_MONTH[month]} ${gematria(year % 1000)}` };
}

/** Edge dates: Rosh Hashana, leap-year Adar I / II, 30 Heshvan / Kislev, around 1900 and 2100. */
const EDGE_DATES = ["2026-09-12", "2024-03-11", "2024-03-15", "2024-04-08", "2025-03-14", "2023-11-14", "2024-12-31", "2000-01-01", "1900-03-01", "2099-12-31", "1948-05-14", "2026-10-18", "2027-03-10", "2027-04-07", "2016-12-31"];

export const hebrewDates = {
  pool() {
    const r = rng("hebrew-dates:pool");
    const dates = new Set(EDGE_DATES);
    while (dates.size < 120) dates.add(iso(new Date(Date.UTC(1900, 0, 1) + Math.floor(r() * 73000) * 86_400_000)));
    return { items: [...dates].sort().map((d) => ({ id: `hd-${d}`, gregorian: d })) };
  },
  select(pool, opts) {
    return splitPoolWith(pool.items, opts, (it, seed) => {
      const h = hebrewDate(it.gregorian);
      const direction = rng(`${seed}:${it.id}`)() < 0.5 ? "to-hebrew" : "to-gregorian";
      return { id: it.id, direction, gregorian: it.gregorian, hebrew: { day: h.day, month: h.month, monthHe: h.monthHe, year: h.year }, hebrewText: h.text };
    });
  },
  meta: () => ({
    source: { sampling: "pool: 15 edge dates (Rosh Hashana, Adar I / Adar II in leap years, Heshvan / Kislev 30, 1900 and 2099) and 105 dates drawn uniformly from 1900–2099 by a fixed seed; the split's seed picks the dates and the direction", calendar: "Expected Hebrew dates computed with the ICU Hebrew calendar (Intl.DateTimeFormat \"en-u-ca-hebrew\"); cross-checked for all 120 pool dates against @hebcal/core 6.14.4 when the set was built (see SOURCES.md)" },
    fields: { direction: "to-hebrew: convert gregorian; to-gregorian: convert hebrewText", gregorian: "YYYY-MM-DD", hebrew: "{day, month (ICU transliteration), monthHe, year}", hebrewText: "the date as written in Hebrew: day and year in Hebrew numerals (year without the thousands), e.g. ז׳ בחשוון תשפ״ז" },
  }),
};

// ── citations: APA 7 and BibTeX from a record ────────────────────────────

const initials = (given) => given.split(/\s+/).map((g) => (/^[A-Z]\.$/.test(g) ? g : `${g[0]}.`)).join(" ");
const apaName = ([last, given, suffix]) => `${last}, ${initials(given)}${suffix ? `, ${suffix}` : ""}`;
function apaAuthors(authors) {
  const names = authors.map(apaName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, & ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
}
export function formatApa(rec) {
  const head = `${apaAuthors(rec.authors)} (${rec.year}).`;
  const end = (s) => (/[.?!]$/.test(s) ? s : `${s}.`);
  if (rec.type === "book") return `${head} *${end(rec.titleSentence).replace(/\.$/, "")}*. ${end(rec.publisher)}`;
  const issue = rec.issue ? `(${rec.issue})` : "";
  return `${head} ${end(rec.titleSentence)} *${rec.journal}*, *${rec.volume}*${issue}, ${rec.pages}.${rec.doi ? ` https://doi.org/${rec.doi}` : ""}`;
}
export function inText(rec) {
  const a = rec.authors.map(([last]) => last);
  return `(${a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} & ${a[1]}` : `${a[0]} et al.`}, ${rec.year})`;
}
const bibKey = (rec) =>
  `${rec.authors[0][0].normalize("NFD").replace(/[^A-Za-z]/g, "").toLowerCase()}${rec.year}${rec.title.normalize("NFD").replace(/[^A-Za-z ]/g, "").split(" ").find((w) => w.length > 3 && !["with", "from", "über"].includes(w.toLowerCase()))?.toLowerCase() ?? ""}`;
export function formatBibtex(rec) {
  const fields = [["author", rec.authors.map(([l, g, s]) => `${l}, ${s ? `${s}, ` : ""}${g}`).join(" and ")], ["title", `{${rec.title}}`], ["year", String(rec.year)]];
  if (rec.type === "book") fields.push(["publisher", rec.publisher]);
  else {
    fields.push(["journal", rec.journal], ["volume", rec.volume]);
    if (rec.issue) fields.push(["number", rec.issue]);
    fields.push(["pages", rec.pages.replace("–", "--")]);
    if (rec.doi) fields.push(["doi", rec.doi]);
  }
  return `@${rec.type}{${bibKey(rec)},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}`;
}

export const citations = {
  pool() {
    const items = RECORDS.map((rec) => ({ id: `cite-${bibKey(rec)}`, record: rec }));
    return { items };
  },
  select(pool, opts) {
    const { dev, test } = splitPool(pool.items, opts);
    const make = (it) => ({ id: it.id, record: it.record, expected: { apa: formatApa(it.record), inText: inText(it.record), bibtex: formatBibtex(it.record), bibtexKey: bibKey(it.record) } });
    return { dev: dev.map(make), test: test.map(make) };
  },
  meta: () => ({
    source: { sampling: `pool: ${RECORDS.length} records of public-domain books and classic papers (bibliographic facts; compiled for this set, CC0 1.0); the split's seed picks the records` },
    fields: { record: "type (book | article), authors [[last, given, suffix?]], year, title (as published), titleSentence (APA sentence case, proper nouns kept), publisher | journal, volume, issue, pages, doi", expected: "apa: APA 7 reference (Markdown *italics*); inText: APA parenthetical citation; bibtex / bibtexKey: a BibTeX entry (key: first author + year + first word of more than 3 letters)" },
  }),
};
