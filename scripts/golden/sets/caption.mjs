/**
 * caption/xm3600: Crossmodal-3600 images with their Hebrew and English
 * reference captions, half of each split photographed in Israel (locale he).
 * Captions and per-image attribution come from the google/crossmodal-3600
 * repo; the images from Open Images (S3) or Flickr, which the agent
 * container cannot reach — the workflow job xm3600-images runs this builder
 * where they are reachable. Images are resized to ≤ 640 px (JPEG q85).
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { splitPool } from "../../lib/golden.mjs";
import { parseCsv } from "../common.mjs";
import { fetchCached, fetchText, rawUrl, sha256 } from "../fetch.mjs";
import { SRC } from "../defs.mjs";

async function readCaptions(zipPath) {
  const out = [];
  const child = spawn("unzip", ["-p", zipPath, "captions.jsonl"]);
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    out.push({ key: d["image/key"], locale: d["image/locale"], he: d.he?.caption ?? [], en: d.en?.caption ?? [] });
  }
  return out;
}

export const xm3600 = {
  async pool(ctx) {
    const s = SRC.xm3600;
    const zipSha = s.files["web-data/captions.zip"];
    const csvSha = s.files["web-data/image_attributions.csv"];
    fetchCached(ctx.cache, rawUrl(s.repo, s.commit, "web-data/captions.zip"), { sha: zipSha, name: "xm3600-captions.zip" });
    const attributions = new Map(parseCsv(fetchText(ctx.cache, rawUrl(s.repo, s.commit, "web-data/image_attributions.csv"), { sha: csvSha, name: "xm3600-image_attributions.csv" })).map((r) => [r.ImageID, r]));
    const records = (await readCaptions(join(ctx.cache, "xm3600-captions.zip"))).filter((r) => r.he.length && r.en.length && attributions.get(r.key)?.License === "https://creativecommons.org/licenses/by/2.0/");
    if (records.length < 3000) throw new Error(`xm3600: only ${records.length} usable records`);
    const items = records.map((r) => {
      const a = attributions.get(r.key);
      return {
        id: `xm-${r.key}`,
        image: `xm3600/${r.key}.jpg`,
        locale: r.locale,
        refs_he: r.he,
        refs_en: r.en,
        attribution: { title: a.Title, author: a.Author, authorUrl: a.AuthorProfileURL, url: a.OriginalLandingURL, license: "CC BY 2.0", licenseUrl: a.License },
        _src: { subset: a.Subset, original: a.OriginalURL, thumb: a.Thumbnail300KURL },
      };
    });
    return { items, provenance: { repo: `https://github.com/${s.repo}`, commit: s.commit, files: { "web-data/captions.zip": zipSha, "web-data/image_attributions.csv": csvSha }, images: "https://open-images-dataset.s3.amazonaws.com/<subset>/<ImageID>.jpg, else the Flickr original / 300K thumbnail from image_attributions.csv" } };
  },
  /** Half Israel (locale he), half the other 35 locales, in each split. */
  select(pool, opts) {
    const he = pool.items.filter((x) => x.locale === "he");
    const rest = pool.items.filter((x) => x.locale !== "he");
    const half = (n) => Math.floor(n / 2);
    const a = splitPool(he, { ...opts, part: `${opts.part}:he`, nDev: half(opts.nDev), nTest: half(opts.nTest) });
    const b = splitPool(rest, { ...opts, part: `${opts.part}:other`, nDev: opts.nDev - half(opts.nDev), nTest: opts.nTest - half(opts.nTest) });
    const byId = (x, y) => (x.id < y.id ? -1 : 1);
    return { dev: [...a.dev, ...b.dev].sort(byId), test: [...a.test, ...b.test].sort(byId) };
  },
  /** Download and resize the images. Where the hosts are unreachable (the agent container) the dev split is written without them. */
  async finish(items, { cache, split, splitDir }) {
    const sharp = (await import("sharp")).default;
    let complete = true;
    let reachable = true;
    const out = [];
    for (const it of items) {
      const { _src, ...item } = it;
      let buf = null;
      let from = null;
      if (reachable)
        for (const url of [`https://open-images-dataset.s3.amazonaws.com/${_src.subset}/${it.id.slice(3)}.jpg`, _src.original, _src.thumb].filter(Boolean)) {
          try {
            buf = fetchCached(join(cache, "xm3600-images"), url, { name: `${it.id}-${sha256(url).slice(0, 8)}` });
            from = url;
            break;
          } catch {
            /* next host */
          }
        }
      if (!buf) {
        reachable = false;
        complete = false;
        out.push(item);
        continue;
      }
      const jpg = await sharp(buf).rotate().resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      mkdirSync(dirname(join(splitDir, item.image)), { recursive: true });
      writeFileSync(join(splitDir, item.image), jpg);
      out.push({ ...item, imageSource: { url: from, sha256: sha256(buf) } });
    }
    if (!complete && split === "test") throw new Error("xm3600: images unreachable; the test split needs every image");
    return { items: out, complete };
  },
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: every image with Hebrew and English captions and a CC BY 2.0 licence; half of each split from locale he, half from the others (splitPool per stratum)" },
    fields: { image: "the image file (≤ 640 px JPEG, relative to this split's folder; added where Open Images / Flickr are reachable)", refs_he: "Hebrew reference captions", refs_en: "English reference captions", attribution: "CC BY 2.0 credit for the photo: title, author, Flickr page", imageSource: "where the image was downloaded from, and the sha256 of the original bytes" },
    captionsLicense: "CC BY 4.0 (Google LLC)",
  }),
};
