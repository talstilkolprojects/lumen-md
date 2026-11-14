#!/usr/bin/env node
/**
 * Lumen's model mirror (plan W4.14): pin, publish and check a copy of every
 * downloadable model, so no model depends on Hugging Face alone.
 *
 *   npm run models:mirror -- --check [--strict] [--all]
 *       Offline. Lists every model that cannot download without Hugging Face
 *       yet: revision not pinned, no file list, a file with no sha256, a file
 *       over GitHub's 2 GiB. --strict exits 1 when anything is listed.
 *       Always exits 1 when such a model, or a variant left out (hosting.omitted),
 *       has no message for the user in English and Hebrew (plan W6.33).
 *       Default: the models that may be defaults (allowed, in the app); --all: every download.
 *
 *   npm run models:mirror -- --pin [--only <id>[,<id>…]] [--include-conditional]
 *       Needs Hugging Face (owner, 15.9). Pins each model's revision to the
 *       commit `main` points at now and writes its file list into
 *       models/registry.json: size and sha256 of every file the app loads
 *       (LFS files: Hugging Face's own sha256, re-checked on upload; the
 *       others are downloaded and hashed). web-llm models also get their
 *       model library (.wasm). Review the diff, then commit it.
 *
 *   npm run models:mirror -- --upload [--only …] [--from-dir <dir>] [--dry-run]
 *       Owner. Creates one GitHub release per model on the repo (tag
 *       models-<slug>, prerelease, never "latest") with the licence and
 *       attribution in its notes, and uploads every pinned file as a flat
 *       asset (a/b.onnx → a__b.onnx), each downloaded from its pinned source
 *       and checked against the registry first. Assets already there at the
 *       right size are skipped. --from-dir <dir> uploads a converted model
 *       (plan 6.0) from a local folder instead. Needs `gh auth login`.
 *
 *   npm run models:mirror -- --verify [--mirror <url>] [--deep] [--only …]
 *       Reads every pinned file from the mirror only (never Hugging Face):
 *       status and size; --deep downloads and checks the sha256 too. This is
 *       the "Hugging Face blocked" check. The mirror URL: --mirror or
 *       VITE_MODEL_MIRROR_URL.
 *
 * Runs on Node ≥ 22.13 (package.json engines); loads the shared rules from
 * src/ai/modelHosting.ts with --experimental-strip-types.
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY = join(ROOT, "models", "registry.json");
const H = await import(join(ROOT, "src", "ai", "modelHosting.ts"));

/** ONNX dtype of a file name (as transformers.js names them), "config" for the rest. */
export function fileDtype(path) {
  const parts = H.onnxParts(path);
  return parts ? parts.dtype : "config";
}

/** Should a Hugging Face file be mirrored for this model? */
export function keepPath(model, path) {
  const name = path.split("/").pop() ?? "";
  if (/^(\.gitattributes|README\.md|LICENSE(\.\w+)?|\.gitignore)$/i.test(name)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|md|py|ipynb)$/i.test(name)) return false;
  const web = model.hosting?.cache === "webllm/model";
  if (web) return true; // web-llm: the whole MLC folder (config, tokenizer, shards)
  if (/\.(bin|safetensors|msgpack|h5|ot|pt|pth|gguf|tflite|mlmodel|ckpt)$/i.test(name)) return false;
  const parts = H.onnxParts(path);
  if (parts) return (model.hosting?.dtypes ?? ["fp32", "fp16", "q8", "q4", "q4f16"]).includes(parts.dtype);
  return /\.(json|txt|model|tiktoken)$/i.test(name);
}

export function parseArgs(argv) {
  const out = { mode: null, strict: false, all: false, only: null, includeConditional: false, dryRun: false, deep: false, mirror: null, fromDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--check", "--pin", "--upload", "--verify"].includes(a)) out.mode = a.slice(2);
    else if (a === "--strict") out.strict = true;
    else if (a === "--all") out.all = true;
    else if (a === "--include-conditional") out.includeConditional = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--deep") out.deep = true;
    else if (a === "--only") out.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--mirror") out.mirror = argv[++i] ?? null;
    else if (a === "--from-dir") out.fromDir = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** The models a mode works on: downloadable, allowed (or conditional on request), optionally --only. */
export function selectModels(models, opts) {
  return models.filter((m) => {
    if (opts.only) return opts.only.includes(m.id);
    if (m.delivery !== "download" || !m.hosting) return false;
    return m.class === "allowed" || (opts.includeConditional && m.class === "conditional");
  });
}

const readRegistry = () => JSON.parse(readFileSync(REGISTRY, "utf8"));
const writeRegistry = (r) => writeFileSync(REGISTRY, JSON.stringify(r, null, 2) + "\n");

const hfHeaders = () => (process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {});

async function getJson(url) {
  const res = await fetch(url, { headers: hfHeaders() });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return { body: await res.json(), link: res.headers.get("link") };
}

/** Every file of a repo at a commit: [{ path, size, sha256 | null }] (LFS files carry their sha256). */
async function hfTree(repo, rev) {
  const out = [];
  let url = `https://huggingface.co/api/models/${repo}/tree/${rev}?recursive=true&expand=false`;
  while (url) {
    const { body, link } = await getJson(url);
    for (const e of body) if (e.type === "file") out.push({ path: e.path, size: e.size, sha256: e.lfs?.oid ?? null });
    const next = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

/** Download `url` to `file`, returning { bytes, sha256 }. */
async function download(url, file) {
  const res = await fetch(url, { headers: url.startsWith("https://huggingface.co/") ? hfHeaders() : {}, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const src = Readable.fromWeb(res.body);
  src.on("data", (c) => {
    hash.update(c);
    bytes += c.length;
  });
  await pipeline(src, createWriteStream(file));
  return { bytes, sha256: hash.digest("hex") };
}

async function hashFile(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function fileEntry(model, f) {
  return { path: f.path, sha256: f.sha256, bytes: f.bytes, dtype: f.dtype, ...(f.key ? { key: f.key } : {}), ...(f.cache ? { cache: f.cache } : {}), license: model.license, attribution: model.attribution };
}

async function pin(opts) {
  const reg = readRegistry();
  const tmp = mkdtempSync(join(tmpdir(), "lumen-pin-"));
  try {
    for (const m of selectModels(reg.models, opts)) {
      const h = m.hosting;
      if (!h?.hf) {
        console.log(`skip ${m.id}: no Hugging Face repo (converted models are pinned by model-convert.yml)`);
        continue;
      }
      const { body } = await getJson(`https://huggingface.co/api/models/${h.hf}/revision/${h.revision ?? "main"}`);
      const rev = body.sha;
      const tree = (await hfTree(h.hf, rev)).filter((f) => keepPath(m, f.path));
      const files = [];
      for (const f of tree) {
        let sha = f.sha256;
        if (!sha) sha = (await download(H.hfUrl(h.hf, rev, f.path), join(tmp, "f"))).sha256;
        const web = h.cache === "webllm/model";
        files.push(fileEntry(m, { path: f.path, sha256: sha, bytes: f.size, dtype: web ? undefined : fileDtype(f.path), cache: web && f.path === "mlc-chat-config.json" ? "webllm/config" : undefined }));
      }
      if (h.lib) {
        const got = await download(h.lib, join(tmp, "lib"));
        files.push(fileEntry(m, { path: `lib/${h.lib.split("/").pop()}`, sha256: got.sha256, bytes: got.bytes, key: h.lib, cache: "webllm/wasm" }));
      }
      // Files the app pins elsewhere (dictation's tokens.txt) are now pinned here too.
      const kept = new Set(files.map((f) => f.path));
      if (h.unpinned) {
        h.unpinned = h.unpinned.filter((p) => !kept.has(p));
        if (!h.unpinned.length) delete h.unpinned;
      }
      if (h.keyRev && h.keyRev !== rev) console.warn(`! ${m.id}: the app requests revision ${h.keyRev}; pinned ${rev} — update the code's revision with it`);
      h.revision = rev;
      m.files = files;
      const big = files.filter((f) => f.bytes > H.GITHUB_RELEASE_MAX_BYTES);
      console.log(`pinned ${m.id} @ ${rev.slice(0, 12)}: ${files.length} files, ${(files.reduce((s, f) => s + f.bytes, 0) / 1e6).toFixed(0)} MB${big.length ? ` — ${big.length} over 2 GiB (cannot be mirrored on GitHub)` : ""}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeRegistry(reg);
}

const gh = (args, opts = {}) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

export function releaseNotes(m) {
  return [
    `Lumen's mirror of **${m.id}** (plan W4.14), unchanged.`,
    ``,
    `- Source: ${m.source}${m.hosting?.revision ? ` @ ${m.hosting.revision}` : ""}`,
    `- Licence: ${m.license}`,
    `- Attribution: ${m.attribution}`,
    ``,
    `Asset names are the repository paths with "/" written as "__". Every file's sha256 is in models/registry.json; the app checks it before use.`,
  ].join("\n");
}

async function upload(opts) {
  const reg = readRegistry();
  const repo = reg.hosting?.mirror?.releases ?? "talstilkol/lumen-md";
  const tmp = mkdtempSync(join(tmpdir(), "lumen-upload-"));
  try {
    for (const m of selectModels(reg.models, opts)) {
      if (!m.files?.length) {
        console.log(`skip ${m.id}: no pinned files (run --pin first)`);
        continue;
      }
      const tag = H.releaseTag(m);
      let assets = new Map();
      if (!opts.dryRun) {
        try {
          const view = JSON.parse(gh(["release", "view", tag, "--repo", repo, "--json", "assets"]));
          assets = new Map(view.assets.map((a) => [a.name, a.size]));
        } catch {
          const notes = join(tmp, "notes.md");
          writeFileSync(notes, releaseNotes(m));
          gh(["release", "create", tag, "--repo", repo, "--title", `Model mirror: ${m.id}`, "--notes-file", notes, "--prerelease", "--latest=false"]);
        }
      }
      for (const f of m.files) {
        const name = H.assetName(f.path);
        if (f.bytes > H.GITHUB_RELEASE_MAX_BYTES) {
          console.warn(`! ${m.id}/${f.path}: ${f.bytes} bytes is over GitHub's 2 GiB per file — not mirrored`);
          continue;
        }
        if (assets.get(name) === f.bytes) continue;
        const file = join(tmp, name);
        let got;
        if (opts.fromDir) {
          const src = join(opts.fromDir, f.path);
          if (!existsSync(src)) throw new Error(`${src}: missing`);
          got = { bytes: statSync(src).size, sha256: await hashFile(src) };
          if (got.bytes === f.bytes && got.sha256 === f.sha256) copyFileSync(src, file);
        } else {
          const url = f.key ?? H.hfUrl(m.hosting.hf, m.hosting.revision ?? "main", f.path);
          got = await download(url, file);
        }
        if (got.bytes !== f.bytes || got.sha256 !== f.sha256) throw new Error(`${m.id}/${f.path}: got ${got.bytes} bytes sha256 ${got.sha256}, registry says ${f.bytes} / ${f.sha256} — not uploaded`);
        if (opts.dryRun) console.log(`would upload ${tag}/${name} (${f.bytes} bytes)`);
        else gh(["release", "upload", tag, file, "--repo", repo, "--clobber"]);
        rmSync(file, { force: true });
      }
      console.log(`${opts.dryRun ? "checked" : "mirrored"} ${m.id} → ${repo} ${tag}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function verify(opts) {
  const reg = readRegistry();
  const mirror = (opts.mirror ?? process.env.VITE_MODEL_MIRROR_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(mirror)) throw new Error("--verify needs --mirror <url> or VITE_MODEL_MIRROR_URL");
  let ok = 0;
  const bad = [];
  const tmp = mkdtempSync(join(tmpdir(), "lumen-verify-"));
  try {
    for (const m of selectModels(reg.models, opts)) {
      for (const f of m.files ?? []) {
        const [c] = H.candidates(m, f, { mirror, user: null }).filter((x) => x.kind === "mirror");
        if (!c) {
          bad.push(`${m.id}/${f.path}: no mirror URL (no sha256)`);
          continue;
        }
        if (opts.deep) {
          const got = await download(c.url, join(tmp, "f")).catch((e) => ({ error: e.message }));
          if (got.error || got.bytes !== f.bytes || got.sha256 !== f.sha256) bad.push(`${m.id}/${f.path}: ${got.error ?? `${got.bytes} bytes / ${got.sha256}`}`);
          else ok++;
        } else {
          const res = await fetch(c.url, { method: "HEAD" }).catch((e) => ({ ok: false, status: e.message, headers: new Headers() }));
          const len = Number(res.headers.get("content-length"));
          if (!res.ok || len !== f.bytes) bad.push(`${m.id}/${f.path}: ${res.ok ? `${len} bytes, expected ${f.bytes}` : `HTTP ${res.status}`}`);
          else ok++;
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const b of bad) console.log(`✗ ${b}`);
  console.log(`mirror ${mirror}: ${ok} ok, ${bad.length} bad${opts.deep ? " (sha256 checked)" : " (size checked)"}`);
  if (bad.length) process.exitCode = 1;
}

function check(opts) {
  const reg = readRegistry();
  const gaps = H.hostingGaps(reg.models, opts.all ? (m) => m.delivery === "download" : H.isDefaultCandidate);
  const ids = new Set(gaps.map((g) => g.id));
  for (const g of gaps) console.log(`${g.id}: ${g.problem}`);
  const scope = reg.models.filter((m) => (opts.all ? m.delivery === "download" : H.isDefaultCandidate(m)));
  const files = scope.reduce((s, m) => s + (m.files?.length ?? 0), 0);
  const unhashed = scope.reduce((s, m) => s + (m.files ?? []).filter((f) => !H.hasSha(f)).length + (m.hosting?.unpinned?.length ?? 0), 0);
  console.log(`models:mirror --check: ${scope.length - ids.size}/${scope.length} models can download without Hugging Face; ${files} pinned files, ${unhashed} without sha256`);
  // W6.33: a model that is (partly) only on Hugging Face must say so, in English and in Hebrew.
  const only = opts.all ? (m) => m.delivery === "download" : H.isDefaultCandidate;
  const messages = H.mirrorMessages(reg.models, only);
  const silent = [];
  for (const [lang, strings] of Object.entries(messageStrings())) for (const s of H.silentHfOnly(reg.models, strings, only)) silent.push(`${lang}: ${s}`);
  for (const s of silent) console.log(`no message: ${s}`);
  console.log(`models:mirror --check: ${new Set(messages.filter((x) => x.gap !== "omitted").map((x) => x.id)).size} models only on Hugging Face and ${messages.filter((x) => x.gap === "omitted").length} variants left out, each with a message; ${silent.length} without a message`);
  if (silent.length) process.exitCode = 1;
  if (opts.strict && gaps.length) process.exitCode = 1;
}

/** The strings the messages need: English (the lazy chunk) and Hebrew. */
export function messageStrings() {
  const en = JSON.parse(readFileSync(join(ROOT, "src", "i18n", "lazy", "modelSources.json"), "utf8"));
  const he = JSON.parse(readFileSync(join(ROOT, "src", "i18n", "locales", "he", "common.json"), "utf8"));
  return { en, he };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const run = { check, pin, upload, verify }[opts.mode ?? "check"];
  Promise.resolve(run(opts)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
