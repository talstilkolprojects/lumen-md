/**
 * The translation files' layout (plan 0.3), shared by the i18n scripts and
 * tests. One source of truth for where a key lives:
 *
 *   src/i18n/locales/<lang>/<domain>.json   flat { "key": "value" }, keys sorted
 *   i18n/keys/<domain>.json                 the extracted English source strings
 *
 * A key's domain is decided by its first segment (`cmd.view.zen` → cmd);
 * a first segment no domain lists goes to `common`. Files are written with
 * their keys sorted, one per line, so two branches that add keys to
 * different domains touch different files, and two that add keys to the
 * same domain usually touch different lines: neither conflicts in a merge.
 * English is bundled with the app (src/i18n/index.ts imports
 * locales/en/*.json eagerly); every other language loads lazily.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LOCALES_DIR = join(ROOT, "src", "i18n", "locales");
export const KEYS_DIR = join(ROOT, "i18n", "keys");
export const SOURCE_LOCALE = "en";

/** Domain → the first key segments it holds. Anything else lands in `common`. */
export const DOMAINS = {
  cmd: ["cmd", "group", "palette", "desc"],
  ai: ["ai", "agent", "research", "batch", "fineTune", "doctor", "suggest", "tts", "voice", "dictate", "spell"],
  editor: [
    "block", "insertText", "findReplace", "mdTable", "format", "mode", "editor", "suggesting", "chart",
    "outline", "focusMode", "writingGoal", "docTabs", "dnd", "comment", "commentsPanel", "bibtex", "vaultCite",
  ],
  canvas: ["canvas", "graphView"],
  settings: [
    "themeSettings", "theme", "privacy", "trustedKeys", "org", "auth", "billing", "audit", "runtimeMetrics",
    "plugin", "pluginGallery",
  ],
  files: [
    "tree", "vault", "trash", "versionHistory", "doc", "contextMenu", "search", "searchDialog", "tagsPanel",
    "backlinks", "git", "sample", "collab", "clip", "template", "templates",
  ],
  toast: ["toast"],
  common: [],
};
export const CATCH_ALL = "common";

const BY_SEGMENT = new Map(Object.entries(DOMAINS).flatMap(([d, segs]) => segs.map((s) => [s, d])));

/** The domain file a key belongs in. */
export function domainOf(key) {
  return BY_SEGMENT.get(key.split(".")[0]) ?? CATCH_ALL;
}

/** Language codes that have a folder under src/i18n/locales/. */
export function listLocales(dir = LOCALES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** One language's strings, all domains merged. */
export function readLocale(lang, dir = LOCALES_DIR) {
  const folder = join(dir, lang);
  const out = {};
  if (!existsSync(folder)) return out;
  for (const name of readdirSync(folder).filter((n) => n.endsWith(".json")).sort()) {
    Object.assign(out, JSON.parse(readFileSync(join(folder, name), "utf8")));
  }
  return out;
}

/** Sorted by key (code-unit order: the same on every machine). */
export function sortedObject(map) {
  const out = {};
  for (const k of Object.keys(map).sort()) out[k] = map[k];
  return out;
}

/** `map` split into { domain: { key: value } }, every part sorted. */
export function splitByDomain(map) {
  const parts = {};
  for (const [k, v] of Object.entries(map)) (parts[domainOf(k)] ??= {})[k] = v;
  for (const d of Object.keys(parts)) parts[d] = sortedObject(parts[d]);
  return parts;
}

/** The text of one JSON file as the layout writes it. */
export function formatJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Write one language's strings as domain files, replacing that language's
 * folder: a domain with no keys has no file. Returns the files written.
 */
export function writeLocale(lang, map, dir = LOCALES_DIR) {
  const folder = join(dir, lang);
  const parts = splitByDomain(map);
  mkdirSync(folder, { recursive: true });
  for (const name of readdirSync(folder)) {
    if (name.endsWith(".json") && !(name.slice(0, -5) in parts)) rmSync(join(folder, name));
  }
  const written = [];
  for (const [d, part] of Object.entries(parts)) {
    const file = join(folder, `${d}.json`);
    writeFileSync(file, formatJson(part));
    written.push(file);
  }
  return written;
}

/** Every `{var}` placeholder in a string, once each, in order. */
export function placeholders(text) {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

/**
 * The extracted English source strings, per domain:
 * { domain: { version, domain, source, entries: [{ key, en, vars }] } }.
 * No timestamp and no counts, so a file changes only where its strings do.
 */
export function buildKeyFiles(en) {
  const out = {};
  for (const [d, part] of Object.entries(splitByDomain(en))) {
    const entries = Object.entries(part).map(([key, value]) => ({ key, en: value, vars: placeholders(value) }));
    // No count: two branches adding a key to one domain would both change it.
    out[d] = { version: 2, domain: d, source: `src/i18n/locales/en/${d}.json`, entries };
  }
  return out;
}

/** All extracted entries from i18n/keys/*.json, in domain then key order. */
export function readKeyEntries(dir = KEYS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .flatMap((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).entries ?? []);
}
