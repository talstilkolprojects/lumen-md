/**
 * Shared helpers for the golden-set builders: paths, the manifest a new set
 * starts from, seeds, and Hebrew text utilities.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, newCanary, readJson, writeJson } from "../lib/golden.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const GOLDEN = join(ROOT, "eval", "golden");

const PART_KEYS = ["id", "items", "dev", "test", "status", "license", "workflow", "token", "owner", "review"];

/**
 * The set's folder with a manifest. A new set gets fresh dev and test
 * canaries and its parts from defs.mjs; an existing one keeps its canaries,
 * version and build state.
 */
export function ensureSet(def) {
  const dir = join(GOLDEN, def.id);
  mkdirSync(dir, { recursive: true });
  const mPath = join(dir, "manifest.json");
  if (existsSync(mPath)) return dir;
  const parts = def.parts.map((p) => {
    const out = {};
    for (const k of PART_KEYS) if (p[k] !== undefined) out[k] = p[k];
    if (p.status === "local-only") out.devSelection = null;
    else if (p.dev > 0) out.devFiles = [];
    return out;
  });
  writeJson(mPath, {
    schema: SCHEMA,
    set: def.id,
    title: def.title,
    capability: def.capability,
    metric: def.metric,
    target: def.target,
    license: def.license,
    canary: newCanary(),
    version: 0,
    frozen: false,
    status: "partial",
    parts,
    test: {
      note: "The test split is never committed. CI rebuilds it with the secret GOLDEN_SEED; only these hashes are recorded.",
      canary: newCanary(),
      items: def.parts.reduce((a, p) => a + p.test, 0),
      sha256: null,
      parts: Object.fromEntries(def.parts.map((p) => [p.id, null])),
    },
    files: {},
    changelog: [],
  });
  return dir;
}

export const manifestOf = (dir) => readJson(join(dir, "manifest.json"));

// ── Hebrew text ─────────────────────────────────────────────────────────

/** Points and cantillation (not maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun hafukha U+05C6). */
export const NIKUD = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
export const stripNikud = (s) => s.replace(NIKUD, "");
export const HEB_LETTER = /[\u05D0-\u05EA]/;
export const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/** Share of Hebrew letters followed by at least one point (a fully vocalised text is close to 1). */
export function vocalisedShare(s) {
  const chars = Array.from(s);
  let letters = 0;
  let marked = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!HEB_LETTER.test(chars[i])) continue;
    letters++;
    let j = i + 1;
    let hasMark = false;
    while (j < chars.length && /[\u0591-\u05C7]/.test(chars[j]) && !/[\u05BE\u05C0\u05C3\u05C6]/.test(chars[j])) {
      hasMark = true;
      j++;
    }
    if (hasMark) marked++;
  }
  return letters ? marked / letters : 0;
}

/** Sentences of a paragraph: split after . ! ? (and their Hebrew-text variants) followed by a space. */
export function sentences(paragraph) {
  return paragraph
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+(?=\S)/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, newlines in quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** UTF-8 byte offsets of a substring found at a JS index (for selections Python slices). */
export function byteSpan(text, index, length) {
  const start = Buffer.byteLength(text.slice(0, index), "utf8");
  return [start, start + Buffer.byteLength(text.slice(index, index + length), "utf8")];
}

export const pad = (n, w = 3) => String(n).padStart(w, "0");
