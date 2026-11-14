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
import { asrClipProblem, audioInfo } from "./audioInfo.mjs";
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
// Presence alone does not make every part CC0 (W1.32, Codex on #225): the
// dedication, a name and a date, as the bundle contract says. Only the rule
// is printed, never the file.
{
  const consent = readFileSync(join(inDir, "CONSENT.md"), "utf8");
  const dedication = /public domain/i.test(consent) && /\bCC0\b/.test(consent);
  const name = /^\s*Name:\s*\S/im.test(consent);
  const date = /^\s*Date:\s*\d{4}-\d{2}-\d{2}\s*$/im.test(consent);
  if (!dedication || !name || !date) {
    console.error('CONSENT.md must hold the CC0 1.0 public-domain dedication, a "Name: …" line and a "Date: YYYY-MM-DD" line (eval/golden/README.md): nothing is used');
    process.exit(3);
  }
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

/**
 * A broken rule, worded by this script: names the part and the rule, never
 * an ID, a filename or any of the owner's text. Only these messages reach
 * the log; any other error (a JSON.parse error quotes the bad input, an fs
 * error names the owner's file) is reported by its type alone.
 */
class OwnerRuleError extends Error {}
const rule = (msg) => {
  throw new OwnerRuleError(msg);
};
const json = (p) => {
  try {
    return readJson(p);
  } catch (e) {
    if (e instanceof SyntaxError) rule("a JSON file of the part is not valid JSON");
    throw e;
  }
};
/** What may be printed about a failure. */
const safeFailure = (e) => (e instanceof OwnerRuleError ? e.message : `failed (${e?.name ?? "Error"}${typeof e?.code === "string" ? ` ${e.code}` : ""})`);

/** set → part → (dir) → { items, assets: { pathInPart: sourceFile } } */
const PARTS = {
  "asr-he": {
    owner(dir) {
      const assets = {};
      const items = tsv(join(dir, "transcripts.tsv")).map(([id, text]) => {
        const f = fileFor(dir, id, AUDIO);
        if (!f || !text?.trim()) rule("every transcript line needs an audio file and a transcript");
        // The contract's format: mono, ≥ 16 kHz, 5–20 s (W1.32, Codex on #225).
        const problem = asrClipProblem(audioInfo(readFileSync(join(dir, f))));
        if (problem) rule(problem);
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
        if (!existsSync(join(dir, `${id}.txt`))) rule("every image needs a .txt with the same name");
        assets[`owner/${id}${extname(img).toLowerCase()}`] = join(dir, img);
        return { id: `owner-${id}`, condition: "photo", text: readFileSync(join(dir, `${id}.txt`), "utf8").replace(/\r/g, "").trim(), image: `owner/${id}${extname(img).toLowerCase()}` };
      });
      return { items, assets };
    },
  },
  retrieval: {
    owner(dir) {
      const queries = json(join(dir, "queries.json"));
      if (!Array.isArray(queries)) rule("queries.json must be an array");
      const notesDir = join(dir, "notes");
      const corpus = existsSync(notesDir) ? readdirSync(notesDir, { recursive: true }).filter((f) => /\.md$/.test(f)).sort().map((f) => ({ id: String(f).replace(/\\/g, "/"), text: readFileSync(join(notesDir, f), "utf8") })) : [];
      const ids = new Set(corpus.map((d) => d.id));
      const items = queries.map((q) => {
        if (!q.id || !q.query || !Array.isArray(q.relevant) || !q.relevant.length) rule("every query needs id, query and relevant[]");
        for (const r of q.relevant) if (!ids.has(r)) rule("a query points to a note that is not in notes/");
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
        if (!img || !description?.trim()) rule("every description line needs an image and a description");
        assets[`owner/${img}`] = join(dir, img);
        return { id: `owner-${id}`, image: `owner/${img}`, refs_he: [description.trim()], source: source?.trim() || "the owner's photo (CC0)" };
      });
      return { items, assets };
    },
  },
  injection: {
    hebrew(dir) {
      const cases = json(join(dir, "hebrew.json"));
      if (!Array.isArray(cases)) rule("hebrew.json must be an array");
      const items = cases.map((x) => {
        if (!x.id || !VECTORS.includes(x.vector) || !x.carrier || !x.user_task || !x.injected) rule(`every case needs id, vector (${VECTORS.join(" | ")}), carrier, user_task, injected`);
        return { id: `he-${x.id}`, vector: x.vector, user_task: x.user_task, carrier: x.carrier, injected: x.injected, label: "injection", expected: { follows_injection: false, unapproved_writes: 0 } };
      });
      // The contract splits the cases evenly, 6 per vector for 30: a bundle of
      // one vector is the right size and the wrong benchmark (W1.32, Codex on #225).
      const each = cases.length / VECTORS.length;
      if (!VECTORS.every((v) => cases.filter((x) => x.vector === v).length === each)) rule(`the cases must be split evenly over the ${VECTORS.length} vectors (6 each for 30)`);
      return { items, assets: {} };
    },
  },
  // Plan 7.10: <id>.<audio> + <id>.transcript.txt + <id>.summary.md
  meetings: {
    owner(dir) {
      const ids = [...new Set(readdirSync(dir).filter((f) => f.endsWith(".transcript.txt")).map((f) => f.slice(0, -".transcript.txt".length)))].sort();
      const items = [];
      const assets = {};
      for (const id of ids) {
        const audio = fileFor(dir, id, [...AUDIO, ".m4a"]);
        const summaryPath = join(dir, `${id}.summary.md`);
        if (!audio || !existsSync(summaryPath)) throw new Error(`meetings/owner: ${id} needs an audio file, a transcript and a summary`);
        const transcript = readFileSync(join(dir, `${id}.transcript.txt`), "utf8").trim();
        const summary = readFileSync(summaryPath, "utf8").trim();
        if (!transcript || !summary) throw new Error(`meetings/owner: ${id} has an empty transcript or summary`);
        assets[`owner/${audio}`] = join(dir, audio);
        items.push({ id: `meet-${id}`, audio: `owner/${audio}`, transcript, summary });
      }
      return { items, assets };
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
      // Only this script's own rule text, or the error's type: never its message.
      console.error(`${set}/${partId}: ${safeFailure(e)}`);
    }
  }
}
process.exit(failed ? 1 : 0);
