#!/usr/bin/env node
/**
 * The held-out evaluator (plan W6.17): sets the feature authors never see.
 *
 *   npm run heldout -- status                 the sets, their sources, licences and seals (no key needed)
 *   npm run heldout -- keygen [--out FILE]    a new evaluator key (owner / nightly host only); prints the public half
 *   npm run heldout -- build [--record] [--rotate] [--sets a,b]
 *                                             fetch the public pools, draw the sets with the key, encrypt them
 *   npm run heldout -- run --models a,b [--url U] [--out DIR] [--sets a,b] [--asr-model DIR]
 *                                             score the sets; writes aggregate numbers only and logs who asked
 *   npm run heldout -- scan [--diff REV] [--prs 12,34|open] [--paths a,b] [--require-key] [--out FILE]
 *                                             contamination check: canaries anywhere, item n-grams with the key
 *   npm run heldout -- log [--verify]         who asked for a score, when, on which versions
 *   npm run heldout -- export --to R --out F  a copy of the sets for one run on a cloud GPU (plan W6.18), encrypted to
 *                                             that run's key; the cloud scores it with LUMEN_HELDOUT_EXPORT=F and the run key
 *
 * The key: $LUMEN_HELDOUT_KEY, or --key-file FILE, or ~/.config/lumen-heldout/key. It comes from
 * Tal or the nightly host and never from the repo: a key file inside the checkout is refused.
 * Bundles and the log live in $LUMEN_HELDOUT_DIR (default ~/.cache/lumen-heldout), never in the repo.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  addedLines,
  buildIndex,
  canaryGuid,
  commitment,
  decrypt,
  deriveSecrets,
  encrypt,
  findCanaries,
  fingerprint,
  generateKey,
  logEntry,
  publicId,
  recipientOf,
  rotate,
  scanDocument,
  secretForms,
  setDigest,
  sha256,
  verifyLog,
} from "./lib/heldout.mjs";
import { OCR_FONTS, SETS, SOURCES, drawAll, setById } from "./heldout/sets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const FLAGS = new Set(["--record", "--rotate", "--require-key", "--verify", "--yes"]);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) positional.push(a);
  else if (FLAGS.has(a)) opts[a.slice(2)] = true;
  else if (a.includes("=")) opts[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
  else opts[a.slice(2)] = argv[++i];
}
const command = positional[0] ?? "status";
const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const insideRepo = (p) => {
  const r = resolve(p);
  return r === ROOT || r.startsWith(ROOT + "/");
};
const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

const MANIFEST = join(ROOT, "eval/heldout/manifest.json");
const COMMITS = join(ROOT, "eval/heldout/commitments");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const store = resolve(opts.store ?? process.env.LUMEN_HELDOUT_DIR ?? join(homedir(), ".cache", "lumen-heldout"));
if (insideRepo(store)) die(`the bundle folder must be outside the repo (${store})`);
const logFile = join(store, "log.jsonl");
const selected = list(opts.sets).length ? list(opts.sets) : SETS.map((s) => s.id);
for (const id of selected) if (!setById(id)) die(`unknown set "${id}" — sets: ${SETS.map((s) => s.id).join(", ")}`);
const requester = String(opts.requester ?? process.env.LUMEN_HELDOUT_REQUESTER ?? `${safeUser()}@${hostname()}`);
function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function loadKey({ required }) {
  const file = opts["key-file"] ?? (process.env.LUMEN_HELDOUT_KEY ? null : join(homedir(), ".config", "lumen-heldout", "key"));
  let secret = process.env.LUMEN_HELDOUT_KEY ?? null;
  if (!secret && file && existsSync(file)) {
    if (insideRepo(file)) die("the key file is inside the repo: move it out (the key never lives in the repo)");
    secret = readFileSync(file, "utf8").trim();
  }
  if (!secret) {
    if (required) die("no held-out key: set LUMEN_HELDOUT_KEY or pass --key-file (Tal or the nightly host holds it)");
    return null;
  }
  const recipient = recipientOf(secret);
  // A run copy (plan W6.18): the sets re-encrypted by the evaluator to a one-run key, for a cloud GPU.
  // It carries the commit secret (to check the digests), never the split secret or the evaluator's key.
  if (process.env.LUMEN_HELDOUT_EXPORT) {
    const ex = decrypt(readFileSync(process.env.LUMEN_HELDOUT_EXPORT), secret);
    if (manifest.recipient && ex.from !== manifest.recipient) die(`the run copy was made with another evaluator key (${fingerprint(ex.from)}, the manifest's is ${fingerprint(manifest.recipient)})`);
    return { secret, recipient, exported: ex, secrets: { commit: Buffer.from(ex.commitKey, "hex"), split: null } };
  }
  if (manifest.recipient && manifest.recipient !== recipient) die(`this key (${fingerprint(recipient)}) is not the evaluator's key of the manifest (${fingerprint(manifest.recipient)})`);
  return { secret, recipient, secrets: deriveSecrets(secret) };
}

const git = (args) => spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const bundlePath = (id) => join(store, `${id}.lho`);
const setMeta = (id) => manifest.sets.find((s) => s.id === id);

function loadBundle(id, key) {
  let b = key.exported ? (key.exported.sets[id] ?? null) : null;
  if (!key.exported) {
    const p = bundlePath(id);
    if (!existsSync(p)) return null;
    b = decrypt(readFileSync(p), key.secret);
  }
  if (!b) return null;
  const cs = b.items.map((it) => commitment(key.secrets.commit, id, it));
  const digest = setDigest(cs);
  if (digest !== b.digest) throw new Error(`${id}: the bundle's items do not match its digest`);
  return { ...b, commitments: cs };
}

// ── status ────────────────────────────────────────────────────────────────

if (command === "status") {
  const key = loadKey({ required: false });
  console.log(`Held-out sets (plan W6.17) — evaluator key: ${manifest.recipient ? fingerprint(manifest.recipient) : "not recorded yet (owner: npm run heldout -- keygen)"}; this machine: ${key ? `has the key (${fingerprint(key.recipient)})` : "no key"}\n`);
  for (const s of manifest.sets) {
    const sealed = s.sealed ? `sealed v${s.sealed.version} (${s.sealed.n} items, digest ${s.sealed.digest.slice(0, 16)}…, ${s.sealed.builtAt.slice(0, 10)})` : "not sealed yet";
    const bundle = existsSync(bundlePath(s.id)) ? "bundle here" : "no bundle here";
    console.log(`  ${s.id.padEnd(12)} ${String(s.size).padStart(4)} items  ${s.license.padEnd(13)} ${SOURCES[s.source].name} — ${sealed}; ${bundle}`);
  }
  console.log(`\nTotal ${manifest.sets.reduce((n, s) => n + s.size, 0)} items. Bundles: ${store}`);
  process.exit(0);
}

// ── keygen ────────────────────────────────────────────────────────────────

if (command === "keygen") {
  const out = resolve(opts.out ?? join(homedir(), ".config", "lumen-heldout", "key"));
  if (insideRepo(out)) die("the key must be written outside the repo");
  if (existsSync(out) && !opts.yes) die(`${out} exists; pass --yes to replace it (every bundle must then be rebuilt)`);
  const k = generateKey();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, k.secret + "\n", { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`Wrote the evaluator's secret key to ${out} (mode 600). Never commit it, never paste it into a PR or a chat.`);
  console.log(`Its public half (safe to commit; contributors encrypt to it):\n  ${k.recipient}\nfingerprint ${fingerprint(k.recipient)}. Record it with: npm run heldout -- build --record`);
  process.exit(0);
}

// ── log ───────────────────────────────────────────────────────────────────

if (command === "log") {
  const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  if (opts.verify) {
    const p = verifyLog(text);
    for (const x of p) console.error(`✗ ${x}`);
    if (!p.length) console.log(`✓ ${text.trim() ? text.trim().split("\n").length : 0} entries, chain intact`);
    process.exit(p.length ? 1 : 0);
  }
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const e = JSON.parse(line);
    console.log(`#${e.seq} ${e.at} ${e.action.padEnd(5)} by ${e.requester} on ${e.commit?.slice(0, 9) ?? "?"}: ${(e.sets ?? []).map((s) => `${s.id} v${s.version ?? "?"}`).join(", ")}${e.models?.length ? ` · ${e.models.join(", ")}` : ""}`);
  }
  process.exit(0);
}

function appendLog(entry) {
  mkdirSync(store, { recursive: true });
  const line = logEntry(existsSync(logFile) ? readFileSync(logFile, "utf8") : "", { at: new Date().toISOString(), requester, host: hostname(), commit: git(["rev-parse", "HEAD"]).stdout.trim() || null, ...entry });
  appendFileSync(logFile, line + "\n");
  return JSON.parse(line);
}

// ── build ─────────────────────────────────────────────────────────────────

/** A pool's rows, piped from fetch.py (or read from --from-rows DIR, for tests): { meta, rows }. */
async function pool(name, revision) {
  if (opts["from-rows"]) {
    const lines = readFileSync(join(opts["from-rows"], `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { meta: lines[0].meta, rows: lines.slice(1) };
  }
  const child = spawn("python3", ["-I", join(ROOT, "scripts/heldout/fetch.py"), "rows", name, ...(revision ? ["--revision", revision] : [])], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  let meta = null;
  const rows = [];
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line) continue;
    const j = JSON.parse(line);
    if (j.meta) meta = j.meta;
    else rows.push(j);
  }
  const code = await new Promise((r) => child.on("close", r));
  // fetch.py prints only download progress and refusals: safe to show
  if (code !== 0 || !meta) die(`fetch.py rows ${name} failed (exit ${code}): ${err.trim().split("\n").slice(-3).join(" | ")}`, 3);
  return { meta, rows };
}

// ── export: a one-run copy for a cloud GPU (plan W6.18) ───────────────────

if (command === "export") {
  const key = loadKey({ required: true });
  if (key.exported) die("export needs the evaluator's own key, not a run copy");
  if (!opts.to || !opts.out) die("usage: npm run heldout -- export --to <lumen-heldout-1… recipient> --out FILE [--sets a,b]");
  if (insideRepo(opts.out)) die("the run copy must be written outside the repo");
  const sets = {};
  for (const id of selected) {
    const b = loadBundle(id, key);
    if (!b) die(`${id}: no bundle in ${store} (npm run heldout -- build)`);
    const { commitments: _c, used: _u, retired: _r, ...rest } = b;
    sets[id] = rest;
  }
  writeFileSync(resolve(opts.out), encrypt({ schema: 1, from: key.recipient, commitKey: key.secrets.commit.toString("hex"), sets }, opts.to, "run copy"));
  const entry = appendLog({ action: "export", to: fingerprint(opts.to), sets: Object.values(sets).map((b) => ({ id: b.set, version: b.version, digest: b.digest })) });
  console.log(`Run copy of ${Object.keys(sets).length} sets for ${fingerprint(opts.to)} → ${resolve(opts.out)} (logged as #${entry.seq})`);
  process.exit(0);
}

if (command === "build") {
  const key = loadKey({ required: true });
  if (key.exported) die("build needs the evaluator's own key; a run copy can only score");
  const sets = selected.map(setById);
  const needSets = [...new Set(sets.flatMap((s) => [...(s.after ?? []), s.id]))].map(setById);
  const pools = {};
  const metas = {};
  for (const name of [...new Set(needSets.flatMap((s) => s.rows))]) {
    const pinned = manifest.sets.find((m) => setById(m.id).rows.includes(name) && m.sealed?.revisions?.[name])?.sealed.revisions[name] ?? null;
    const { meta, rows } = await pool(name, opts.repin ? null : pinned);
    pools[name] = rows;
    metas[name] = meta;
    console.log(`pool ${name}: ${rows.length} rows @ ${meta.revision} (${meta.license})`);
  }
  const drawn = drawAll(needSets, pools, key.secrets);
  let fonts = [];
  if (selected.includes("ocr-he") && !opts["from-rows"]) {
    const { pinFonts } = await import("./heldout/ocr.mjs");
    fonts = await pinFonts(OCR_FONTS, join(store, "cache"));
  }
  mkdirSync(store, { recursive: true });
  for (const set of sets) {
    const m = setMeta(set.id);
    const old = existsSync(bundlePath(set.id)) ? loadBundle(set.id, key) : null;
    let items = drawn[set.id];
    let retired = old?.retired ?? [];
    let used = old?.used ?? [];
    if (opts.rotate) {
      if (!old) die(`${set.id}: nothing to rotate (no bundle yet)`);
      // Fresh items are drawn the set's own way (its accept rules) from the pool rows no version used.
      const usedNow = new Set([...used, ...old.items.map((x) => x.id)]);
      const unused = Object.fromEntries(set.rows.map((r) => [r, pools[r].filter((row) => !usedNow.has(set.prefix + row.id))]));
      const fresh = set.select({ ...pools, ...unused }, key.secrets, drawn);
      const r = rotate(old.items, fresh, { splitKey: key.secrets.split, version: (old.version ?? 1) + 1, used: usedNow });
      items = r.items;
      retired = [...retired, ...r.retired];
    }
    used = [...new Set([...used, ...items.map((x) => x.id)])];
    const cs = items.map((it) => commitment(key.secrets.commit, set.id, it));
    const digest = setDigest(cs);
    const version = m.sealed ? (m.sealed.digest === digest ? m.sealed.version : m.sealed.version + 1) : 1;
    const source = { revisions: Object.fromEntries(set.rows.map((r) => [r, metas[r].revision])), files: Object.assign({}, ...set.rows.map((r) => metas[r].files)), ...(set.id === "ocr-he" ? { fonts } : {}) };
    const bundle = { schema: 1, set: set.id, version, canary: m.canary, builtAt: new Date().toISOString(), source, digest, retired, used, items };
    writeFileSync(bundlePath(set.id), encrypt(bundle, key.recipient, `${set.id} v${version}`));
    console.log(`${set.id}: ${items.length} items, v${version}, digest ${digest.slice(0, 16)}…${opts.rotate ? `, ${retired.length - (old?.retired?.length ?? 0)} replaced` : ""} → ${bundlePath(set.id)}`);
    if (opts.record) {
      m.sealed = { version, builtAt: bundle.builtAt, n: items.length, digest, revisions: source.revisions, files: source.files, ...(fonts.length && set.id === "ocr-he" ? { fonts: fonts.map((f) => ({ pkg: f.pkg, version: f.version, sha256: f.sha256 })) } : {}) };
      mkdirSync(COMMITS, { recursive: true });
      writeFileSync(join(COMMITS, `${set.id}.json`), JSON.stringify({ set: set.id, version, digest, about: "HMAC-SHA256 commitments of the items under the evaluator's key: they let the evaluator prove a version, and reveal nothing without the key.", commitments: [...cs].sort() }, null, 1) + "\n");
    }
  }
  if (opts.record) {
    manifest.recipient = key.recipient;
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nRecorded the seals in eval/heldout/manifest.json and eval/heldout/commitments/ — commit them (they hold hashes only).`);
  }
  appendLog({ action: "build", sets: sets.map((s) => ({ id: s.id, version: setMeta(s.id).sealed?.version ?? null })), recorded: !!opts.record });
  process.exit(0);
}

// ── run ───────────────────────────────────────────────────────────────────

if (command === "run") {
  const key = loadKey({ required: true });
  const models = list(opts.models ?? "qwen2.5:7b");
  const url = String(opts.url ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const outDir = resolve(opts.out ?? "eval/results/heldout");
  let version = null;
  try {
    version = await (await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(5000) })).json();
  } catch {
    /* no Ollama: the Ollama sets are reported as unavailable */
  }
  const S = await import("./heldout/score.mjs");
  const results = {};
  for (const id of selected) {
    const b = loadBundle(id, key);
    const m = setMeta(id);
    if (!b) {
      results[id] = { status: "unavailable", reason: `no bundle in ${store} (npm run heldout -- build)` };
      continue;
    }
    const locked = !!m.sealed && m.sealed.digest === b.digest;
    if (m.sealed && !locked) die(`${id}: the bundle (v${b.version}) is not the version the manifest recorded (v${m.sealed.version}); rebuild it or record the new one`);
    const r = { version: b.version, digest: b.digest, n: b.items.length, locked, models: {} };
    const set = setById(id);
    console.log(`▶ ${id} (${b.items.length} items, v${b.version}${locked ? "" : ", not sealed yet"})`);
    if (set.engine === "ollama") {
      for (const model of models) {
        if (!version) {
          r.models[model] = { status: "unavailable", reason: `Ollama does not answer at ${url}` };
          continue;
        }
        const ctx = { url, model };
        r.models[model] = id === "qa-he" ? await S.scoreQa(b.items, ctx) : id === "xling" ? await S.scoreXling(b.items, ctx) : id === "grammar-he" ? await S.scoreGrammarModel(b.items, ctx) : await S.scoreToolcalls(b.items, ctx);
        console.log(`  ${model}: ${summary(r.models[model])}`);
      }
      if (id === "grammar-he") {
        r.checker = await S.scoreGrammarChecker(b.items);
        console.log(`  the app's checker: ${summary(r.checker)}`);
      }
    } else if (set.engine === "asr") {
      r.engine = S.scoreAsr(b.items, { revision: b.source.revisions.fleurs, canary: b.canary, asrModel: opts["asr-model"] });
      console.log(`  zipformer: ${summary(r.engine)}`);
    } else if (set.engine === "ocr") {
      r.engine = await S.scoreOcr(b.items, { fonts: b.source.fonts, canary: b.canary, cache: join(store, "cache") });
      console.log(`  tesseract.js: ${summary(r.engine)}`);
    }
    results[id] = r;
  }
  const kind = version?.lumen_fake ? "wiring" : "model";
  const body = { schema: 1, plan: "W6.17", kind, at: new Date().toISOString(), requester, evaluator: fingerprint(key.recipient), commit: git(["rev-parse", "HEAD"]).stdout.trim() || null, ollama: { url, version: version?.version ?? null }, models, sets: results };
  const entry = appendLog({ action: "score", sets: Object.entries(results).map(([id, r]) => ({ id, version: r.version ?? null, digest: r.digest ?? null })), models, kind, result: sha256(JSON.stringify(body)) });
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `heldout-${body.at.slice(0, 16).replace(/:/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ ...body, log: entry }, null, 2) + "\n");
  console.log(`\n${kind === "wiring" ? "WIRING RUN (fake Ollama) — not a model score. " : ""}Aggregates only → ${file}\nLogged as #${entry.seq} (${entry.requester}, ${entry.at}).`);
  process.exit(0);
}

function summary(m) {
  if (!m) return "—";
  if (m.status) return `${m.status}: ${m.reason}`;
  const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)} %`);
  if (m.valid !== undefined) return `valid ${pct(m.valid)}, intent ${pct(m.intent)}, slot F1 ${m.slotF1}`;
  if (m.accHe !== undefined) return `he ${pct(m.accHe)}, en ${pct(m.accEn)}, mixed ${pct(m.accMixed)}, gap ${pct(m.gapHeEn)}`;
  if (m.f1 !== undefined && m.precision !== undefined) return `P ${m.precision} R ${m.recall} F1 ${m.f1} (n ${m.n})`;
  if (m.correct !== undefined) return `${pct(m.share)} correct, F1 ${m.f1}`;
  if (m.wer !== undefined) return `WER ${pct(m.wer)}, CER ${pct(m.cer)}`;
  if (m.cer !== undefined) return `CER ${pct(m.cer)} (clean ${pct(m.clean?.cerHe)}, degraded ${pct(m.degraded?.cerHe)})`;
  return JSON.stringify(m);
}

// ── scan ──────────────────────────────────────────────────────────────────

if (command === "scan") {
  const key = loadKey({ required: false });
  if (!key && opts["require-key"]) die("scan --require-key: no held-out key, so the n-gram check cannot run");
  const canaries = manifest.sets.map((s) => ({ set: s.id, guid: canaryGuid(s.canary) })).filter((c) => c.guid);
  const exempt = (f) => f === "eval/heldout/manifest.json" || f.startsWith("eval/heldout/commitments/") || /(^|\/)node_modules\//.test(f);
  const docs = [];
  const ls = git(["ls-files", "-co", "--exclude-standard"]);
  for (const f of ls.status === 0 ? ls.stdout.split("\n").filter(Boolean) : []) {
    if (exempt(f)) continue;
    const p = join(ROOT, f);
    if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > 8 * 1024 * 1024) continue;
    const buf = readFileSync(p);
    docs.push({ name: f, text: buf.includes(0) ? null : buf.toString("utf8"), raw: buf.toString("latin1") });
  }
  // --paths a,b: more folders or files to scan (a prompt library, a corpus, a download) — walked, not git-listed.
  for (const base of list(opts.paths)) {
    const walk = (p) => {
      const st = statSync(p);
      if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
      else if (st.isFile() && st.size <= 8 * 1024 * 1024) {
        const buf = readFileSync(p);
        docs.push({ name: p, text: buf.includes(0) ? null : buf.toString("utf8"), raw: buf.toString("latin1") });
      }
    };
    walk(resolve(base));
  }
  if (opts.diff) {
    const d = git(["diff", `${opts.diff}...HEAD`]);
    if (d.status !== 0) die(`git diff ${opts.diff}...HEAD failed: ${d.stderr.trim()}`);
    docs.push({ name: `diff ${opts.diff}...HEAD`, text: addedLines(d.stdout), raw: d.stdout });
  }
  if (opts.prs) {
    const repo = opts.repo ?? "talstilkol/lumen-md";
    const gh = (args) => spawnSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
    let numbers = list(opts.prs);
    if (opts.prs === "open") {
      numbers = [];
      for (let page = 1; page < 20; page++) {
        const r = gh([`repos/${repo}/pulls?state=open&per_page=100&page=${page}`, "--jq", ".[].number"]);
        const got = r.stdout.split("\n").filter(Boolean);
        numbers.push(...got);
        if (got.length < 100) break;
      }
    }
    for (const n of numbers) {
      const diff = gh(["-H", "Accept: application/vnd.github.diff", `repos/${repo}/pulls/${n}`]);
      const body = gh([`repos/${repo}/pulls/${n}`, "--jq", ".body // \"\""]);
      if (diff.status !== 0) {
        console.error(`PR #${n}: diff not readable (${diff.stderr.trim().slice(0, 120)})`);
        continue;
      }
      docs.push({ name: `PR #${n} diff`, text: addedLines(diff.stdout), raw: diff.stdout });
      docs.push({ name: `PR #${n} body`, text: body.stdout, raw: body.stdout });
    }
  }
  const report = { schema: 1, plan: "W6.17", at: new Date().toISOString(), requester, scanned: { documents: docs.length, files: docs.filter((d) => !d.name.startsWith("PR #") && !d.name.startsWith("diff ")).length }, canaryHits: [], keyLeaks: [], items: [], ngram: key ? "on" : "skipped: no key (canaries only)" };
  for (const d of docs) for (const c of findCanaries(d.raw, canaries)) report.canaryHits.push({ in: d.name, set: c.set });
  if (key) {
    const forms = secretForms(key.secret);
    for (const d of docs) if (forms.some((f) => d.raw.includes(f))) report.keyLeaks.push(d.name);
    const units = [];
    for (const id of SETS.map((s) => s.id)) {
      const b = loadBundle(id, key);
      if (!b) continue;
      b.items.forEach((it, i) => setById(id).fields(it).forEach((text, j) => units.push({ id: `${publicId(id, b.commitments[i])}#${j}`, text })));
    }
    const idx = buildIndex(units);
    report.indexed = { units: idx.units.length, tooShort: idx.tooShort };
    const seen = new Set();
    for (const d of docs) {
      if (d.text === null) continue;
      for (const h of scanDocument(idx, d.text)) {
        const k = `${h.id}|${d.name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        report.items.push({ item: h.id.split("#")[0], in: d.name, why: h.why });
      }
    }
  }
  const bad = report.canaryHits.length + report.keyLeaks.length + report.items.length;
  report.verdict = bad ? "contaminated" : "clean";
  if (opts.out) {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2) + "\n");
  }
  console.log(`Contamination scan (plan W6.17): ${report.scanned.documents} documents (${report.scanned.files} repo files), n-gram check ${report.ngram}${report.indexed ? `, ${report.indexed.units} item fields indexed (${report.indexed.tooShort} too short to tell apart)` : ""}`);
  for (const h of report.canaryHits) console.log(`  ✗ canary of ${h.set} in ${h.in}`);
  for (const f of report.keyLeaks) console.log(`  ✗ the evaluator's key is in ${f}`);
  for (const h of report.items) console.log(`  ✗ held-out item ${h.item} in ${h.in} (${h.why})`);
  console.log(bad ? `${bad} finding(s): contaminated.` : "0 held-out items, 0 canaries, 0 keys: clean.");
  process.exit(bad ? 1 : 0);
}

die(`unknown command "${command}" — status, keygen, build, run, scan, log or export`);
