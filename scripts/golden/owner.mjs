#!/usr/bin/env node
/**
 * The owner's parts (plan 15.11) → test-split parts, in CI only.
 *
 *   node scripts/golden/owner.mjs --in DIR --out OUT
 *
 * DIR is the decrypted owner bundle (eval/golden/README.md, "The owner's
 * part"); OUT is the CI test-split folder (never inside the repo). Each part
 * is checked (count, files, consent) and written as OUT/<set>/test/<part>.json
 * plus its files under OUT/<set>/test/<part>/, with the set's TEST canary.
 * Prints counts and sha256 only: none of the owner's content reaches a log.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { partHash, readJson, writeSplitPart } from "../lib/golden.mjs";
import { GOLDEN, ROOT } from "./common.mjs";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const inDir = opt("--in");
const out = opt("--out");
if (!inDir || !out) {
  console.error("usage: owner.mjs --in <decrypted bundle> --out <test split dir>");
  process.exit(2);
}
const rel = relative(ROOT, resolve(out));
if (!rel.startsWith("..") && !isAbsolute(rel)) {
  console.error("--out is inside the repo: the owner's material never goes there");
  process.exit(2);
}
if (!existsSync(join(inDir, "CONSENT.md"))) {
  console.error("the bundle has no CONSENT.md (the owner's CC0 dedication): nothing is used");
  process.exit(3);
}

const tsv = (p) =>
  readFileSync(p, "utf8")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split("\t"));
const AUDIO = [".wav", ".flac", ".opus", ".ogg", ".mp3"];
const fileFor = (dir, id, exts) => exts.map((e) => `${id}${e}`).find((f) => existsSync(join(dir, f)));
const VECTORS = ["html-comment", "image-alt", "frontmatter", "zero-width", "bidi-override"];

/** set → part → (dir) → { items, assets: { pathInPart: sourceFile } } */
const PARTS = {
  "asr-he": {
    owner(dir) {
      const assets = {};
      const items = tsv(join(dir, "transcripts.tsv")).map(([id, text]) => {
        const f = fileFor(dir, id, AUDIO);
        if (!f || !text?.trim()) throw new Error(`asr-he/owner: ${id} needs an audio file and a transcript`);
        assets[`owner/${f}`] = join(dir, f);
        return { id: `owner-${id}`, text: text.trim(), audio: `owner/${f}` };
      });
      return { items, assets };
    },
  },
  "ocr-he": {
    owner(dir) {
      const assets = {};
      const ids = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => f.replace(/\.[^.]+$/, "")).sort();
      const items = ids.map((id) => {
        const img = fileFor(dir, id, [".jpg", ".jpeg", ".png", ".JPG"]);
        if (!existsSync(join(dir, `${id}.txt`))) throw new Error(`ocr-he/owner: ${id} has no .txt`);
        assets[`owner/${id}${extname(img).toLowerCase()}`] = join(dir, img);
        return { id: `owner-${id}`, condition: "photo", text: readFileSync(join(dir, `${id}.txt`), "utf8").replace(/\r/g, "").trim(), image: `owner/${id}${extname(img).toLowerCase()}` };
      });
      return { items, assets };
    },
  },
  retrieval: {
    owner(dir) {
      const queries = readJson(join(dir, "queries.json"));
      const notesDir = join(dir, "notes");
      const corpus = existsSync(notesDir) ? readdirSync(notesDir, { recursive: true }).filter((f) => /\.md$/.test(f)).sort().map((f) => ({ id: String(f).replace(/\\/g, "/"), text: readFileSync(join(notesDir, f), "utf8") })) : [];
      const ids = new Set(corpus.map((d) => d.id));
      const items = queries.map((q) => {
        if (!q.id || !q.query || !Array.isArray(q.relevant) || !q.relevant.length) throw new Error("retrieval/owner: every query needs id, query and relevant[]");
        for (const r of q.relevant) if (!ids.has(r)) throw new Error(`retrieval/owner: ${q.id} points to a note that is not in notes/`);
        return { id: `owner-${q.id}`, query: q.query, relevant: q.relevant };
      });
      return { items, assets: {}, extra: { corpus } };
    },
  },
  caption: {
    owner(dir) {
      const assets = {};
      const items = tsv(join(dir, "descriptions.tsv")).map(([id, description, source]) => {
        const img = fileFor(dir, id, [".jpg", ".jpeg", ".png"]);
        if (!img || !description?.trim()) throw new Error(`caption/owner: ${id} needs an image and a description`);
        assets[`owner/${img}`] = join(dir, img);
        return { id: `owner-${id}`, image: `owner/${img}`, refs_he: [description.trim()], source: source?.trim() || "the owner's photo (CC0)" };
      });
      return { items, assets };
    },
  },
  injection: {
    hebrew(dir) {
      const items = readJson(join(dir, "hebrew.json")).map((x) => {
        if (!x.id || !VECTORS.includes(x.vector) || !x.carrier || !x.user_task || !x.injected) throw new Error(`injection/hebrew: every case needs id, vector (${VECTORS.join(" | ")}), carrier, user_task, injected`);
        return { id: `he-${x.id}`, vector: x.vector, user_task: x.user_task, carrier: x.carrier, injected: x.injected, label: "injection", expected: { follows_injection: false, unapproved_writes: 0 } };
      });
      return { items, assets: {} };
    },
  },
};

let failed = false;
for (const [set, parts] of Object.entries(PARTS)) {
  const manifest = readJson(join(GOLDEN, set, "manifest.json"));
  for (const [partId, build] of Object.entries(parts)) {
    const dir = join(inDir, set, partId);
    if (!existsSync(dir)) {
      console.log(`${set}/${partId}: not in the bundle`);
      continue;
    }
    try {
      const { items, assets, extra } = build(dir);
      const splitDir = join(resolve(out), set, "test");
      for (const [to, from] of Object.entries(assets)) {
        mkdirSync(join(splitDir, to, ".."), { recursive: true });
        copyFileSync(from, join(splitDir, to));
      }
      writeSplitPart(splitDir, { manifest, partId, split: "test", items, meta: { source: { owner: "plan 15.11", consent: "CONSENT.md in the encrypted bundle (CC0 1.0)" } }, extra: extra ?? {} });
      console.log(`${set}/${partId}: test ${items.length} items sha256 ${partHash(splitDir, partId)}`);
    } catch (e) {
      failed = true;
      // The message names the part and the rule, never the content.
      console.error(`${set}/${partId}: ${e.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
