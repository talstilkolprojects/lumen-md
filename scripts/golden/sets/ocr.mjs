/**
 * ocr-he parts, rendered in Chromium (Playwright) from six OFL fonts.
 *
 *   lines — 20 images per font (dev 5, test 15), 1–2 lines each: clean,
 *           degraded (blur, rotation, noise, low contrast) or pointed (nikud)
 *   pages — synthetic pages (heading, paragraphs, a list); the browser's own
 *           line breaks are read back as the ground truth
 *
 * Text: Project Ben-Yehuda public-domain essays (genre article, nikud
 * removed), pointed verse from Ben-Yehuda works the nikud set never scans,
 * and document-style lines generated here (dates, amounts, phone-like
 * numbers, English words). The fonts are only used to render; none is
 * committed. Every image is a grayscale PNG that carries its split's canary
 * in a tEXt chunk, so a test image that reaches the repo is caught.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import { devSeed, rankKey, sample, shuffle, testSeed } from "../../lib/golden.mjs";
import { parseCsv, sentences, stripNikud, wordCount } from "../common.mjs";
import { fetchCached, fetchText, rawUrl, sha256 } from "../fetch.mjs";
import { SRC } from "../defs.mjs";
import { benyehuda, fullyPointed } from "./nikud.mjs";

export const FONTS = [
  { pkg: "david-libre", family: "David Libre" },
  { pkg: "frank-ruhl-libre", family: "Frank Ruhl Libre" },
  { pkg: "miriam-libre", family: "Miriam Libre" },
  { pkg: "heebo", family: "Heebo" },
  { pkg: "rubik", family: "Rubik" },
  { pkg: "assistant", family: "Assistant" },
];

// ── Fonts ───────────────────────────────────────────────────────────────

/** @font-face rules (data: URLs) for the Hebrew and Latin subsets, 400 and 700, from the pinned npm tarballs. */
function fontFaces(cache) {
  const v = SRC.fonts.version;
  const rules = [];
  const files = {};
  for (const f of FONTS) {
    const name = `fontsource-${f.pkg}-${v}.tgz`;
    const tgz = join(cache, "fonts", name);
    fetchCached(join(cache, "fonts"), `https://registry.npmjs.org/@fontsource/${f.pkg}/-/${f.pkg}-${v}.tgz`, { sha: SRC.fonts.packages[f.pkg].tgz, name });
    files[`@fontsource/${f.pkg}@${v}`] = SRC.fonts.packages[f.pkg].tgz;
    const dir = join(cache, "fonts", `x-${f.pkg}-${v}`);
    if (!existsSync(join(dir, "package", "hebrew-400.css"))) {
      mkdirSync(dir, { recursive: true });
      const want = ["hebrew", "latin"].flatMap((sub) => ["400", "700"].flatMap((w) => [`package/${sub}-${w}.css`, `package/files/${f.pkg}-${sub}-${w}-normal.woff2`]));
      const r = spawnSync("tar", ["-xzf", tgz, "-C", dir, ...want], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`tar ${name}: ${r.stderr}`);
    }
    for (const sub of ["hebrew", "latin"])
      for (const w of ["400", "700"]) {
        const css = readFileSync(join(dir, "package", `${sub}-${w}.css`), "utf8");
        const range = css.match(/unicode-range:\s*([^;]+);/)?.[1];
        const woff = readFileSync(join(dir, "package", "files", `${f.pkg}-${sub}-${w}-normal.woff2`)).toString("base64");
        rules.push(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:${w};src:url(data:font/woff2;base64,${woff}) format('woff2');unicode-range:${range};}`);
      }
  }
  return { css: rules.join("\n"), files };
}

// ── Text pools (public) ─────────────────────────────────────────────────

const CLEAN_TEXT = /^[\u05D0-\u05EA\s,.;:!?()"'\-–\u05BE\u05F3\u05F4]+$/;

/** Unpointed prose sentences (5–14 words, ≤ 70 characters) from Ben-Yehuda essays. */
function prosePool(cache) {
  const s = SRC.benyehuda;
  const works = parseCsv(fetchText(cache, rawUrl(s.repo, s.commit, "pseudocatalogue.csv"), { sha: s.files["pseudocatalogue.csv"], name: "benyehuda-pseudocatalogue.csv" })).filter((w) => w.genre.endsWith(".article") && !w.translators && /^\/p\d+\/m\d+$/.test(w.path));
  const out = [];
  let fetched = 0;
  for (const w of shuffle(works, "lumen-golden-v1:ocr-he:prose", (x) => x.ID)) {
    if (out.length >= 400 || ++fetched > 400) break;
    let text;
    try {
      text = fetchText(cache, rawUrl(s.repo, s.commit, `txt${w.path}.txt`), { name: `benyehuda-${w.ID}.txt` });
    } catch {
      continue;
    }
    const found = text
      .replace(/\r/g, "")
      .split(/\n\s*\n/)
      .flatMap((p) => sentences(stripNikud(p)))
      .filter((t) => wordCount(t) >= 5 && wordCount(t) <= 14 && t.length <= 70 && CLEAN_TEXT.test(t))
      .slice(0, 4);
    found.forEach((t, k) => out.push({ id: `p${w.ID}-${k + 1}`, text: t, work: Number(w.ID) }));
  }
  if (out.length < 250) throw new Error(`ocr prose pool: only ${out.length} sentences`);
  return out;
}

/** Pointed verse (5–12 words) from Ben-Yehuda poetry the nikud set never scans (it stops where its pool is full). */
function nikudPool(cache, scanned) {
  const s = SRC.benyehuda;
  const works = parseCsv(fetchText(cache, rawUrl(s.repo, s.commit, "pseudocatalogue.csv"), { name: "benyehuda-pseudocatalogue.csv" })).filter((w) => w.genre.endsWith(".poetry") && !w.translators && /^\/p\d+\/m\d+$/.test(w.path));
  const nikudScanned = new Set(scanned);
  const out = [];
  let fetched = 0;
  for (const w of shuffle(works, "lumen-golden-v1:ocr-he:nikud", (x) => x.ID)) {
    if (out.length >= 60 || ++fetched > 900) break;
    if (nikudScanned.has(w.ID)) continue;
    let text;
    try {
      text = fetchText(cache, rawUrl(s.repo, s.commit, `txt${w.path}.txt`), { name: `benyehuda-${w.ID}.txt` });
    } catch {
      continue;
    }
    const lines = text
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => wordCount(l) >= 5 && wordCount(l) <= 12 && !/[0-9A-Za-z]/.test(l) && fullyPointed(l));
    lines.slice(0, 2).forEach((t, k) => out.push({ id: `n${w.ID}-${k + 1}`, text: t, work: Number(w.ID) }));
  }
  if (out.length < 40) throw new Error(`ocr nikud pool: only ${out.length} lines`);
  return out;
}

/** A document-style line (written for this set), filled from `seed`. */
const DOC_LINES = [
  "תאריך: {date} | שעה: {time}",
  "סה״כ לתשלום: ₪{amount}",
  "חשבונית מס׳ {num} מיום {date}",
  "טלפון: {phone} | פקס: {phone2}",
  "הפגישה נקבעה ל-{date} בשעה {time} בחדר {room}.",
  "קובץ ה-PDF מצורף; גרסה {ver}.",
  "המשתתפים: {n} איש, מתוכם {k} ב-Zoom.",
  "הנחה של {pct}% על כל המוצרים עד {date}.",
  "כתובת האתר: www.example.co.il/{slug}",
  "מספר הזמנה {num}, משלוח בתוך {days} ימי עסקים.",
  "שלב {k} מתוך {n}: בדיקת Wi-Fi ו-Bluetooth.",
  "עודכן לאחרונה: {date}, {time}",
  "פרק {n}: סיכום הישיבה מ-{date}",
  "מחיר ליחידה: {amount} ש״ח (כולל מע״מ)",
  "לפרטים: info@example.org או {phone}",
];
const SLUGS = ["about", "contact", "docs/start", "blog/2024", "help"];

export function docLine(seed, key) {
  const h = (k) => parseInt(rankKey(seed, `${key}:${k}`).slice(0, 8), 16);
  const t = DOC_LINES[h("t") % DOC_LINES.length];
  const two = (k, mod, base = 0) => String(base + (h(k) % mod)).padStart(2, "0");
  const v = {
    date: `${two("d", 28, 1)}.${two("mo", 12, 1)}.${2020 + (h("y") % 7)}`,
    time: `${two("hh", 12, 8)}:${["00", "15", "30", "45"][h("mm") % 4]}`,
    amount: `${(h("a") % 9000) + 100},${String(h("c") % 100).padStart(2, "0")}`,
    num: String(10000 + (h("num") % 89999)),
    phone: `0${[2, 3, 4, 8, 9][h("p") % 5]}-${String(h("p2") % 10000000).padStart(7, "0")}`,
    phone2: `0${[2, 3, 4, 8, 9][h("q") % 5]}-${String(h("q2") % 10000000).padStart(7, "0")}`,
    room: String(100 + (h("r") % 400)),
    ver: `${1 + (h("v") % 4)}.${h("v2") % 10}`,
    n: String(2 + (h("n") % 9)),
    k: String(1 + (h("k") % (2 + (h("n") % 9)))),
    pct: String(5 + 5 * (h("pct") % 9)),
    slug: SLUGS[h("s") % SLUGS.length],
    days: String(2 + (h("days") % 6)),
  };
  return t.replace(/\{(\w+)\}/g, (_, k) => v[k]);
}

/** The public pools, built once per run (both parts use them). */
let pools;
function textPools(ctx) {
  if (pools) return pools;
  const nik = benyehuda.pool(ctx);
  const prose = prosePool(ctx.cache);
  const nikud = nikudPool(ctx.cache, Object.keys(nik.provenance.files).map((f) => f.match(/m(\d+)\.txt$/)?.[1]).filter(Boolean));
  // Lines and pages draw from disjoint halves of the prose pool, so a dev page never holds a test line.
  const half = (x) => (rankKey("lumen-golden-v1:ocr-he:halves", x.id)[0] < "8" ? "lines" : "pages");
  pools = { prose, nikud, proseLines: prose.filter((x) => half(x) === "lines"), prosePages: prose.filter((x) => half(x) === "pages") };
  return pools;
}

// ── Plans (which text, font and look each image gets) ───────────────────

const pick = (seed, key, n) => parseInt(rankKey(seed, key).slice(0, 8), 16) % n;

function degrade(seed, id) {
  return { blur: [0.5, 0.7, 0.9][pick(seed, `${id}:blur`, 3)], rotate: [-1.2, -0.7, 0.6, 1.1][pick(seed, `${id}:rot`, 4)], contrast: [0.55, 0.7][pick(seed, `${id}:con`, 2)], noise: 1 + pick(seed, `${id}:noise`, 999) };
}

/** Per font: dev 5 = 3 clean + 1 degraded + 1 nikud; test 15 = 9 + 4 + 2. */
const LINE_PLAN = { dev: { clean: 3, degraded: 1, nikud: 1 }, test: { clean: 9, degraded: 4, nikud: 2 } };

function planLines(pools, split, seed, devUsed) {
  const per = LINE_PLAN[split];
  const nPlain = FONTS.length * (per.clean + per.degraded);
  const nNikud = FONTS.length * per.nikud;
  const proseAvail = pools.proseLines.filter((x) => !devUsed.has(x.id));
  const nikudAvail = pools.nikud.filter((x) => !devUsed.has(x.id));
  const prose = sample(proseAvail, nPlain, `${seed}:prose`);
  const nikud = sample(nikudAvail, nNikud, `${seed}:nikud`);
  const items = [];
  let pi = 0;
  let ni = 0;
  FONTS.forEach((f, fi) => {
    const conds = [...Array(per.clean).fill("clean"), ...Array(per.degraded).fill("degraded"), ...Array(per.nikud).fill("nikud")];
    conds.forEach((cond, k) => {
      const id = `line-${f.pkg}-${split}-${k + 1}`;
      let text;
      let used;
      if (cond === "nikud") {
        used = [nikud[ni++]];
        text = used[0].text;
      } else {
        // Half the plain lines are prose, half a document line; some prose images get a second line.
        const doc = pick(seed, `${id}:kind`, 2) === 0;
        const first = prose[pi++];
        used = doc ? [] : [first];
        const lines = [doc ? docLine(seed, id) : first.text];
        if (!doc && pick(seed, `${id}:two`, 3) === 0) lines.push(docLine(seed, `${id}:b`));
        text = lines.join("\n");
      }
      items.push({
        id,
        font: f.family,
        fontPackage: `@fontsource/${f.pkg}`,
        weight: pick(seed, `${id}:w`, 4) === 0 ? 700 : 400,
        size: [26, 30, 34, 38][pick(seed, `${id}:size`, 4)],
        condition: cond,
        text,
        sources: used.map((u) => ({ benyehuda: u.work, unit: u.id })),
        ...(cond === "degraded" ? { degrade: degrade(seed, id) } : {}),
        _fi: fi,
      });
    });
  });
  return items;
}

function planPages(pools, split, seed, n, devUsed) {
  const avail = pools.prosePages.filter((x) => !devUsed.has(x.id));
  const need = n * 9;
  const prose = sample(avail, need, `${seed}:pages`);
  const items = [];
  for (let i = 0; i < n; i++) {
    const id = `page-${split}-${String(i + 1).padStart(2, "0")}`;
    const chunk = prose.slice(i * 9, i * 9 + 9);
    const f = FONTS[pick(seed, `${id}:font`, FONTS.length)];
    const blocks = [
      { tag: "h1", text: docLine(seed, `${id}:title`).replace(/[:|].*$/, "").trim() || "סיכום" },
      { tag: "p", text: chunk.slice(0, 3).map((x) => x.text).join(" ") },
      { tag: "p", text: chunk.slice(3, 6).map((x) => x.text).join(" ") },
      { tag: "li", text: `• ${docLine(seed, `${id}:li1`)}` },
      { tag: "li", text: `• ${docLine(seed, `${id}:li2`)}` },
      { tag: "p", text: chunk.slice(6, 9).map((x) => x.text).join(" ") },
    ];
    items.push({ id, font: f.family, fontPackage: `@fontsource/${f.pkg}`, size: [20, 22, 24][pick(seed, `${id}:size`, 3)], condition: pick(seed, `${id}:cond`, 2) === 0 ? "degraded" : "clean", blocks, sources: chunk.map((u) => ({ benyehuda: u.work, unit: u.id })) });
    if (items.at(-1).condition === "degraded") items.at(-1).degrade = degrade(seed, id);
  }
  return items;
}

// ── Rendering ───────────────────────────────────────────────────────────

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function styleFor(it) {
  const d = it.degrade;
  const filter = d ? `filter: blur(${d.blur}px) contrast(${d.contrast});` : "";
  const transform = d ? `transform: rotate(${d.rotate}deg);` : "";
  return { filter, transform };
}

function noiseSvg(d) {
  return d ? `<svg width="100%" height="100%" style="position:absolute;inset:0;mix-blend-mode:multiply;opacity:.35" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${d.noise}"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>` : "";
}

/** Insert a tEXt chunk (keyword "Comment") after IHDR. */
export function pngWithText(png, text) {
  const data = Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.from(text, "latin1")]);
  const type = Buffer.from("tEXt", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), len, type, data, crc, png.subarray(ihdrEnd)]);
}

let rendererVersion = "";

async function render(items, { cache, splitDir, partId, canary, kind }) {
  const { chromium } = await import("playwright");
  const sharp = (await import("sharp")).default;
  const { css } = fontFaces(cache);
  // GOLDEN_CHROMIUM: another Chromium binary, where Playwright's own build is not installed (the agent container).
  const browser = await chromium.launch(process.env.GOLDEN_CHROMIUM ? { executablePath: process.env.GOLDEN_CHROMIUM } : {});
  rendererVersion = browser.version();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
    const out = [];
    for (const it of items) {
      const { filter, transform } = styleFor(it);
      let body;
      if (kind === "lines") {
        body = `<div id="box" style="display:inline-block;position:relative;padding:18px 24px;background:#fff;overflow:hidden"><div style="${filter}${transform}font-family:'${it.font}';font-size:${it.size}px;font-weight:${it.weight};line-height:1.45;white-space:pre;color:#111">${esc(it.text)}</div>${noiseSvg(it.degrade)}</div>`;
      } else {
        const blocks = it.blocks.map((b, bi) => {
          const words = b.text.split(" ").map((w, wi) => `<span data-b="${bi}" data-w="${wi}">${esc(w)}</span>`).join(" ");
          if (b.tag === "h1") return `<h1 style="font-size:1.5em;margin:0 0 .6em">${words}</h1>`;
          if (b.tag === "li") return `<div style="margin:.2em 1.2em 0 0">${words}</div>`;
          return `<p style="margin:0 0 .8em;text-align:justify">${words}</p>`;
        });
        body = `<div id="box" style="position:relative;width:760px;padding:56px 64px;background:#fff;overflow:hidden"><div style="${filter}${transform}font-family:'${it.font}';font-size:${it.size}px;line-height:1.55;color:#111">${blocks.join("")}</div>${noiseSvg(it.degrade)}</div>`;
      }
      await page.setContent(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css}html,body{margin:0;background:#fff}</style></head><body>${body}</body></html>`);
      // Load the faces this image uses (Hebrew and Latin subsets), then make sure they did.
      const loaded = await page.evaluate(
        async ({ fam, weight }) => {
          const faces = [...(await document.fonts.load(`${weight} 16px '${fam}'`, "\u05D0\u05D1\u05D2")), ...(await document.fonts.load(`${weight} 16px '${fam}'`, "Abc"))];
          await document.fonts.ready;
          return faces.filter((f) => f.status === "loaded").length;
        },
        { fam: it.font, weight: it.weight ?? 400 },
      );
      if (loaded < 2) throw new Error(`font ${it.font} did not load`);
      const shot = await page.locator("#box").screenshot({ animations: "disabled" });
      const png = await sharp(shot).grayscale().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      const file = `${partId}/${it.id}.png`;
      mkdirSync(dirname(join(splitDir, file)), { recursive: true });
      writeFileSync(join(splitDir, file), pngWithText(png, canary));
      const { _fi, blocks, ...rest } = it;
      let text = it.text;
      let lines;
      if (kind === "pages") {
        // Read back the rendered lines: words grouped by their line box, in logical order.
        lines = await page.evaluate(() => {
          // Measure without the rotation (a transform moves the boxes, not the line breaks).
          const inner = document.querySelector("#box > div");
          const saved = inner.style.transform;
          inner.style.transform = "none";
          const spans = [...document.querySelectorAll("span[data-w]")];
          const rows = [];
          for (const s of spans) {
            const r = s.getClientRects()[0];
            const mid = (r.top + r.bottom) / 2;
            const b = s.dataset.b;
            const last = rows.at(-1);
            if (last && last.b === b && Math.abs(last.mid - mid) < (r.bottom - r.top) / 2) last.words.push(s.textContent);
            else rows.push({ b, mid, words: [s.textContent] });
          }
          inner.style.transform = saved;
          return rows.map((row) => ({ block: Number(row.b), text: row.words.join(" ") }));
        });
        text = lines.map((l) => l.text).join("\n");
        rest.blocks = blocks.map((b) => ({ tag: b.tag }));
      }
      out.push({ ...rest, text, ...(lines ? { lines } : {}), image: file });
    }
    return out;
  } finally {
    await browser.close();
  }
}

// ── Parts ───────────────────────────────────────────────────────────────

const makePart = (kind) => ({
  pool(ctx) {
    const p = textPools(ctx);
    return { items: kind === "lines" ? [...p.proseLines, ...p.nikud] : p.prosePages, pools: p, fonts: fontFaces(ctx.cache).files };
  },
  select(pool, opts) {
    const dSeed = devSeed(opts.set, opts.part);
    const plan = (split, seed, used) => (kind === "lines" ? planLines(pool.pools, split, seed, used) : planPages(pool.pools, split, seed, split === "dev" ? opts.nDev : opts.nTest, used));
    const dev = plan("dev", dSeed, new Set());
    if (kind === "lines" && dev.length !== opts.nDev) throw new Error(`ocr lines: plan gives ${dev.length} dev items, the manifest says ${opts.nDev}`);
    if (!opts.nTest) return { dev, test: [] };
    if (!opts.secret) throw new Error("the test split needs GOLDEN_SEED");
    const used = new Set(dev.flatMap((it) => it.sources.map((s) => s.unit)));
    const test = plan("test", testSeed(opts.secret, opts.set, opts.part), used);
    return { dev, test };
  },
  async finish(items, ctx) {
    const canary = ctx.split === "dev" ? ctx.manifest.canary : ctx.manifest.test.canary;
    return { items: await render(items, { cache: ctx.cache, splitDir: ctx.splitDir, partId: ctx.partId, canary, kind }), complete: true };
  },
  meta: (pool) => ({
    source: {
      repo: `https://github.com/${SRC.benyehuda.repo}`,
      commit: SRC.benyehuda.commit,
      files: { "pseudocatalogue.csv": SRC.benyehuda.files["pseudocatalogue.csv"], ...pool.fonts },
      sampling:
        kind === "lines"
          ? "per font: dev 3 clean + 1 degraded + 1 nikud, test 9 + 4 + 2; prose from the lines half of the essay pool, pointed verse from poetry the nikud set does not scan, document lines generated (docLine); texts, sizes, weights and degradations drawn with the split's seed; dev texts never reused in test"
          : "9 essay sentences per page from the pages half of the essay pool, headings and list items generated (docLine); font, size and degradation drawn with the split's seed; dev texts never reused in test",
      renderer: `Chromium ${rendererVersion} via Playwright, deviceScaleFactor 1, grayscale PNG via sharp`,
    },
    fields:
      kind === "lines"
        ? { image: "PNG, relative to this split's folder", text: "the exact rendered text, lines separated by \\n", condition: "clean | degraded | nikud", font: "font family (OFL, @fontsource 5.3.0)", degrade: "blur px, rotation deg, contrast, noise seed", sources: "Ben-Yehuda work ids the text comes from" }
        : { image: "PNG, relative to this split's folder", text: "the rendered lines, \\n-separated (the browser's own breaks)", lines: "[{block, text}]", blocks: "the block structure (h1, p, li)", condition: "clean | degraded" },
    textLicense: "Ben-Yehuda texts are public domain; generated lines and the images are CC0 1.0",
  }),
});

export const lines = makePart("lines");
export const pages = makePart("pages");

export { sha256 };
