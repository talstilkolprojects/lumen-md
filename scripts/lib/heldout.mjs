/**
 * The held-out evaluator (plan W6.17): sets that the agents who write
 * features never see. This file is the pure part — keys, encryption, the
 * keyed split, commitments, canaries, the contamination check, the
 * evaluator's log and the scoring rules — so it can be tested without a
 * key, a model or a download. scripts/heldout.mjs is the CLI around it.
 *
 * How the items stay hidden:
 * - The sets are drawn from public, openly licensed sources that no dev set
 *   in this repo uses (eval/heldout/manifest.json names each one and its
 *   licence). Which items a set holds is decided by an HMAC keyed with the
 *   evaluator's secret, so without the key nobody can tell which items of
 *   the public pool are held out.
 * - The items live only in bundles encrypted to the evaluator's X25519 key
 *   (X25519 + HKDF-SHA256 + ChaCha20-Poly1305, all node:crypto), outside the
 *   repo. The private key comes from Tal or the nightly host at run time
 *   (LUMEN_HELDOUT_KEY or --key-file), never from the repo.
 * - The repo holds only hashes keyed with the same secret, the sets'
 *   sources, sizes and licences, and one canary per set.
 * - The evaluator prints and writes aggregate numbers only. Item ids in its
 *   output are keyed commitments, never text.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const SCHEMA = 1;
export const CANARY_PREFIX = "LUMEN HELDOUT SET - DO NOT TRAIN OR TUNE ON THIS DATA. canary GUID ";
const SECRET_PREFIX = "LUMEN-HELDOUT-SECRET-KEY-1";
const PUBLIC_PREFIX = "lumen-heldout-1";
const MAGIC = Buffer.from("LHO1");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** JSON with sorted keys, so the same value always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// ── keys ──────────────────────────────────────────────────────────────────

/** A new evaluator key pair: { secret: "LUMEN-HELDOUT-SECRET-KEY-1…", recipient: "lumen-heldout-1…" }. */
export function generateKey() {
  const { privateKey } = generateKeyPairSync("x25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  return { secret: SECRET_PREFIX + b64u(d), recipient: recipientOf(SECRET_PREFIX + b64u(d)) };
}

function privateKeyObject(secret) {
  const s = String(secret ?? "").trim();
  if (!s.startsWith(SECRET_PREFIX)) throw new Error(`not a held-out key (it starts with ${SECRET_PREFIX})`);
  const raw = Buffer.from(s.slice(SECRET_PREFIX.length), "base64url");
  if (raw.length !== 32) throw new Error("the held-out key is damaged (32 bytes expected)");
  return { raw, key: createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" }) };
}

/** The public half, safe to commit and to give to contributors. */
export function recipientOf(secret) {
  const { key } = privateKeyObject(secret);
  return PUBLIC_PREFIX + createPublicKey(key).export({ format: "jwk" }).x;
}

function publicKeyObject(recipient) {
  const r = String(recipient ?? "").trim();
  if (!r.startsWith(PUBLIC_PREFIX)) throw new Error(`not a held-out recipient (it starts with ${PUBLIC_PREFIX})`);
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: r.slice(PUBLIC_PREFIX.length) }, format: "jwk" });
}

/** A short public fingerprint of a recipient, for the manifest and the log. */
export const fingerprint = (recipient) => sha256(String(recipient)).slice(0, 16);

/**
 * The keyed secrets derived from the evaluator's key: `split` ranks the pool
 * (which items are held out), `commit` makes the hashes the repo keeps.
 */
export function deriveSecrets(secret) {
  const { raw } = privateKeyObject(secret);
  const d = (info) => Buffer.from(hkdfSync("sha256", raw, Buffer.from("lumen-heldout-v1"), Buffer.from(info), 32));
  return { split: d("split"), commit: d("commit") };
}

// ── encryption ────────────────────────────────────────────────────────────

function payloadKey(shared, epk, recipient) {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([Buffer.from(epk), Buffer.from(recipient)]), Buffer.from("lumen-heldout-v1 payload"), 32));
}

/**
 * Encrypt a JSON value to a recipient. Layout: "LHO1", a 4-byte header
 * length, the header (JSON: version, ephemeral key, nonce, the recipient's
 * fingerprint, a label), then the gzip'd payload under ChaCha20-Poly1305 with
 * the header as associated data, then the 16-byte tag.
 */
export function encrypt(value, recipient, label = "") {
  const eph = generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ format: "jwk" }).x;
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject(recipient) });
  const nonce = randomBytes(12);
  const header = Buffer.from(JSON.stringify({ v: 1, alg: "x25519-hkdf-sha256-chacha20poly1305", epk, nonce: b64u(nonce), to: fingerprint(recipient), label }));
  const cipher = createCipheriv("chacha20-poly1305", payloadKey(shared, epk, recipient), nonce, { authTagLength: 16 });
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(canonical(value)))), cipher.final()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, len, header, body, cipher.getAuthTag()]);
}

/** The header of a bundle, readable without the key. */
export function bundleHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("not a held-out bundle");
  const n = buf.readUInt32BE(4);
  return JSON.parse(buf.subarray(8, 8 + n).toString("utf8"));
}

/** Decrypt a bundle with the evaluator's secret; throws on a wrong key or any changed byte. */
export function decrypt(buf, secret) {
  const h = bundleHeader(buf);
  const n = buf.readUInt32BE(4);
  const header = buf.subarray(8, 8 + n);
  const recipient = recipientOf(secret);
  if (h.to !== fingerprint(recipient)) throw new Error(`this bundle is for another key (${h.to}, this key is ${fingerprint(recipient)})`);
  const { key } = privateKeyObject(secret);
  const shared = diffieHellman({ privateKey: key, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: h.epk }, format: "jwk" }) });
  const decipher = createDecipheriv("chacha20-poly1305", payloadKey(shared, h.epk, recipient), Buffer.from(h.nonce, "base64url"), { authTagLength: 16 });
  decipher.setAAD(header);
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const plain = Buffer.concat([decipher.update(buf.subarray(8 + n, buf.length - 16)), decipher.final()]);
  return JSON.parse(gunzipSync(plain).toString("utf8"));
}

// ── the keyed split and the commitments ───────────────────────────────────

const hmac = (key, text) => createHmac("sha256", key).update(text).digest("hex");

/** The pool ranked by the split secret: the order nobody without the key can reproduce. */
export function rankPool(pool, splitKey, scope, key = (x) => x.id) {
  return pool.map((x) => ({ x, r: hmac(splitKey, `${scope}\u0000${key(x)}`) })).sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0)).map((e) => e.x);
}

/**
 * Take `n` items of the ranked pool that pass `accept`, skipping the ids in
 * `exclude` (items another set from the same source already holds, or items
 * retired by a rotation). Throws when the pool is too small.
 */
export function take(ranked, n, { accept = () => true, exclude = new Set(), key = (x) => x.id } = {}) {
  const out = [];
  for (const x of ranked) {
    if (out.length >= n) break;
    if (!exclude.has(key(x)) && accept(x)) out.push(x);
  }
  if (out.length < n) throw new Error(`the pool holds only ${out.length} eligible items, ${n} wanted`);
  return out;
}

/**
 * The quarterly rotation (plan W6.17 step 4): keep 80 % of the current items
 * (chosen with the key and the new version), replace the rest with items of
 * the pool that no version used before. Returns { items, retired }.
 */
export function rotate(current, ranked, { fraction = 0.2, splitKey, version, used = new Set(), accept = () => true, key = (x) => x.id }) {
  const nOut = Math.round(current.length * fraction);
  const order = rankPool(current, splitKey, `rotate:v${version}`, key);
  const retired = order.slice(0, nOut);
  const kept = order.slice(nOut);
  const exclude = new Set([...used, ...current.map(key)]);
  const fresh = take(ranked, nOut, { accept, exclude, key });
  return { items: [...kept, ...fresh], retired: retired.map(key) };
}

/** An item's commitment: an HMAC with the commit secret, so the repo can keep it without revealing anything. */
export const commitment = (commitKey, set, item) => hmac(commitKey, `${set}\u0000${canonical(item)}`);

/** A set's digest over its items' commitments (order-free). */
export const setDigest = (commitments) => sha256([...commitments].sort().join("\n"));

/** The id an item gets in any output: a prefix of its commitment. */
export const publicId = (set, c) => `${set}:${c.slice(0, 12)}`;

export const newCanary = () => CANARY_PREFIX + randomUUID();
export const canaryGuid = (canary) => String(canary ?? "").slice(CANARY_PREFIX.length) || null;

// ── normalisation and the contamination check ─────────────────────────────

/** Lower case, NFKC, no nikud or cantillation, maqaf and punctuation as spaces. */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[֑-ֽֿ-ׇ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export const tokens = (text) => {
  const n = normalize(text);
  return n ? n.split(" ") : [];
};

export const LONG_N = 13;
export const SHORT_N = 8;
const MIN_TOKENS = 6;
const MIN_CHARS = 20;

/**
 * The probes an item field is checked with: a field of ≥ 13 tokens is
 * contaminated by any 13-gram of it, or by half of its 8-grams in one
 * document; a field of 6–12 tokens only by the whole field in sequence; a
 * shorter one only when it is at least 20 characters long and appears whole.
 * Anything shorter cannot be told apart from ordinary text.
 */
export function probesOf(text) {
  const t = tokens(text);
  if (t.length >= LONG_N) return { kind: "long", long: grams(t, LONG_N), short: grams(t, SHORT_N) };
  if (t.length >= MIN_TOKENS || (t.length >= 2 && t.join(" ").length >= MIN_CHARS)) return { kind: "whole", whole: t.join(" "), n: t.length };
  return { kind: "too-short" };
}
function grams(t, n) {
  const out = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n).join(" "));
  return out;
}

/**
 * The index the scan looks documents up in. `units` are { id, text }: one
 * per item field. Returns { index, units, tooShort }.
 */
export function buildIndex(units) {
  const index = { long: new Map(), short: new Map(), whole: new Map() };
  const add = (m, k, i) => (m.get(k) ?? m.set(k, new Set()).get(k)).add(i);
  const kept = [];
  let tooShort = 0;
  for (const u of units) {
    const p = probesOf(u.text);
    if (p.kind === "too-short") {
      tooShort++;
      continue;
    }
    const i = kept.length;
    kept.push({ id: u.id, probe: p });
    if (p.kind === "long") {
      for (const g of p.long) add(index.long, g, i);
      for (const g of new Set(p.short)) add(index.short, g, i);
    } else add(index.whole, p.whole, i);
  }
  const wholeLengths = [...new Set(kept.filter((k) => k.probe.kind === "whole").map((k) => k.probe.n))];
  return { index, units: kept, tooShort, wholeLengths };
}

/** The units of the index that one document contaminates: [{ id, why }]. */
export function scanDocument(idx, text) {
  const t = tokens(text);
  const hits = new Map();
  const hit = (i, why) => hits.has(i) || hits.set(i, why);
  for (let i = 0; i + LONG_N <= t.length; i++) for (const u of idx.index.long.get(t.slice(i, i + LONG_N).join(" ")) ?? []) hit(u, "13-gram");
  const shortSeen = new Map();
  for (let i = 0; i + SHORT_N <= t.length; i++) {
    const g = t.slice(i, i + SHORT_N).join(" ");
    for (const u of idx.index.short.get(g) ?? []) (shortSeen.get(u) ?? shortSeen.set(u, new Set()).get(u)).add(g);
  }
  for (const [u, seen] of shortSeen) {
    const total = new Set(idx.units[u].probe.short).size;
    if (total && seen.size / total >= 0.5) hit(u, `${Math.round((100 * seen.size) / total)} % of its 8-grams`);
  }
  for (const n of idx.wholeLengths) for (let i = 0; i + n <= t.length; i++) for (const u of idx.index.whole.get(t.slice(i, i + n).join(" ")) ?? []) hit(u, "the whole item");
  return [...hits].map(([u, why]) => ({ id: idx.units[u].id, why }));
}

/** Canaries (GUIDs) found in a text: [{ set, guid }]. */
export const findCanaries = (text, canaries) => canaries.filter((c) => c.guid && text.includes(c.guid));

/** Forms of the secret key a leak would carry: the whole string and its raw part. */
export const secretForms = (secret) => {
  const s = String(secret ?? "").trim();
  return s ? [s, s.slice(SECRET_PREFIX.length)].filter((x) => x.length >= 32) : [];
};

/** Added lines of a unified diff (the text a PR brings in). */
export const addedLines = (diff) =>
  String(diff ?? "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");

// ── the evaluator's log ───────────────────────────────────────────────────

/**
 * Append an entry to the log (a hash chain: each entry carries the hash of
 * the one before, so an edited or removed line breaks every later hash).
 * `lines` is the current log text. Returns the new line.
 */
export function logEntry(lines, entry) {
  const prev = String(lines ?? "").trim().split("\n").filter(Boolean).pop();
  const last = prev ? JSON.parse(prev) : null;
  const body = { ...entry, seq: last ? last.seq + 1 : 1, prev: last ? last.hash : null };
  return JSON.stringify({ ...body, hash: sha256(canonical(body)) });
}

/** Problems of a log (empty = intact): broken chain, changed entry, wrong sequence. */
export function verifyLog(text) {
  const problems = [];
  let prev = null;
  let seq = 0;
  for (const [i, line] of String(text ?? "").trim().split("\n").filter(Boolean).entries()) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1}: not JSON`);
      break;
    }
    const { hash, ...body } = e;
    if (sha256(canonical(body)) !== hash) problems.push(`line ${i + 1}: the entry was changed`);
    if (body.prev !== prev) problems.push(`line ${i + 1}: the chain is broken (an entry before it was changed or removed)`);
    if (body.seq !== ++seq) problems.push(`line ${i + 1}: sequence ${body.seq}, expected ${seq}`);
    prev = hash;
  }
  return problems;
}

// ── scoring rules ─────────────────────────────────────────────────────────

const HE_PREFIX = /^[והבלמשכ]{1,2}(?=[א-ת]{2})/;
const tokensForF1 = (s) => tokens(s).map((w) => w.replace(HE_PREFIX, ""));

/** Token F1 of a prediction against one reference (Hebrew one-letter prefixes dropped). */
export function tokenF1(pred, ref) {
  const p = tokensForF1(pred);
  const r = tokensForF1(ref);
  if (!p.length || !r.length) return p.length === r.length ? 1 : 0;
  const counts = new Map();
  for (const w of r) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of p) if (counts.get(w)) {
    common++;
    counts.set(w, counts.get(w) - 1);
  }
  if (!common) return 0;
  const precision = common / p.length;
  const recall = common / r.length;
  return (2 * precision * recall) / (precision + recall);
}

const YES = new Set(["כן", "yes", "true", "נכון"]);
const NO = new Set(["לא", "no", "false"]);
const numbersIn = (s) => (String(s).replace(/(\d),(\d{3})/g, "$1$2").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

/**
 * A closed-book QA answer against its references (MKQA shape: { type, text,
 * aliases }). Correct when a reference or alias appears in the answer as
 * whole words, a number answer has the same number, or a yes/no answer
 * agrees. Returns { correct, f1 }.
 */
export function qaScore(pred, answers) {
  const p = ` ${tokensForF1(pred).join(" ")} `;
  let correct = false;
  let f1 = 0;
  for (const a of answers) {
    const refs = [a.text, ...(a.aliases ?? [])].filter(Boolean);
    for (const r of refs) {
      f1 = Math.max(f1, tokenF1(pred, r));
      const rn = tokensForF1(r).join(" ");
      if (rn && p.includes(` ${rn} `)) correct = true;
    }
    if (a.type === "binary") {
      const first = tokens(pred)[0];
      const want = YES.has(normalize(a.text)) ? YES : NO.has(normalize(a.text)) ? NO : null;
      if (want && first && want.has(first)) correct = true;
    }
    if (/^number/.test(a.type ?? "")) {
      const want = numbersIn(a.text);
      if (want.length && numbersIn(pred).some((x) => want.includes(x))) correct = true;
    }
  }
  return { correct, f1 };
}

/** The option letter a multiple-choice answer picked (A–D), or null. */
export function mcqLetter(text) {
  const s = String(text ?? "").trim();
  const m = s.match(/^\(?([A-D])\)?(?:[.):\s]|$)/i) ?? s.match(/\b(?:answer|תשובה)\s*(?:is|היא)?\s*[:\-]?\s*\(?([A-D])\b/i) ?? s.match(/\b([A-D])\b/);
  return m ? m[1].toUpperCase() : null;
}

/** MASSIVE's annotated utterance → slots: "[date : מחר]" → [{ type: "date", value: "מחר" }]. */
export function parseSlots(annot) {
  const out = [];
  for (const m of String(annot ?? "").matchAll(/\[\s*([^:\]]+?)\s*:\s*([^\]]+?)\s*\]/g)) out.push({ type: m[1].trim(), value: m[2].trim() });
  return out;
}

/**
 * A model's tool call against the expected intent and slots. `call` is
 * { name, arguments } (or null when the model called nothing); `tools` are
 * the tool definitions it was offered. Returns { valid, intent, slotTp,
 * slotFp, slotFn }.
 */
export function toolCallScore(call, expected, tools) {
  const out = { valid: false, intent: false, slotTp: 0, slotFp: 0, slotFn: expected.slots.length };
  if (!call?.name) return out;
  const tool = tools.find((t) => t.name === call.name);
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : null;
  out.valid = !!tool && !!args && Object.keys(args).every((k) => tool.params.includes(k));
  out.intent = call.name === expected.intent;
  if (!out.intent || !args) return out;
  const want = new Map(expected.slots.map((s) => [`${s.type}\u0000${normalize(s.value)}`, true]));
  let tp = 0;
  let fp = 0;
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined || v === "") continue;
    const key = `${k}\u0000${normalize(Array.isArray(v) ? v.join(" ") : String(v))}`;
    if (want.has(key)) {
      tp++;
      want.delete(key);
    } else fp++;
  }
  return { ...out, slotTp: tp, slotFp: fp, slotFn: want.size };
}

/** A tool call from a model's message: native tool_calls, or a JSON object in the text. */
export function callFromMessage(message) {
  const native = message?.tool_calls?.[0]?.function;
  if (native?.name) {
    let args = native.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    return { name: native.name, arguments: args ?? {} };
  }
  const text = String(message?.content ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const name = j.name ?? j.tool ?? j.function?.name;
    const args = j.arguments ?? j.args ?? j.parameters ?? j.function?.arguments ?? {};
    return name ? { name, arguments: args } : null;
  } catch {
    return null;
  }
}

/**
 * A MASSIVE utterance's grammar label from its crowd judgments: "flawed"
 * when most judges found spelling errors or found it hard to understand,
 * "clean" when every judge found it spelled right and nearly natural, null
 * (left out) otherwise.
 */
export function grammarLabel(judgments) {
  const js = (judgments ?? []).filter((j) => Number.isFinite(j?.spelling_score) && Number.isFinite(j?.grammar_score));
  if (js.length < 2) return null;
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const sp = js.map((j) => j.spelling_score);
  const gr = js.map((j) => j.grammar_score);
  if (median(sp) <= 1 || median(gr) <= 1) return "flawed";
  if (sp.every((x) => x === 2) && Math.min(...gr) >= 3) return "clean";
  return null;
}

/** "Has an error?" answers: כן/yes → true, לא/no → false, else null. */
export function yesNo(text) {
  const first = tokens(text)[0];
  if (!first) return null;
  if (YES.has(first)) return true;
  if (NO.has(first)) return false;
  return null;
}

/** Precision, recall and F1 of binary predictions (`positive` = "flawed"). */
export function prf(pairs) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let unanswered = 0;
  for (const { pred, gold } of pairs) {
    if (pred === null || pred === undefined) unanswered++;
    if (pred && gold) tp++;
    else if (pred && !gold) fp++;
    else if (!pred && gold) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { n: pairs.length, tp, fp, fn, tn, unanswered, precision: round(precision), recall: round(recall), f1: round(precision + recall ? (2 * precision * recall) / (precision + recall) : 0), accuracy: round(pairs.length ? (tp + tn) / pairs.length : 0) };
}

export const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;
