/**
 * English strings of lazily loaded domains (src/i18n/lazy/<domain>.json),
 * for the i18n tests that read the `en` block of src/i18n/index.ts from disk.
 * Same rule as scripts/lib/i18n-lazy.mjs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LAZY_DIR = resolve(__dirname, "..", "..", "i18n", "lazy");

export function lazyEnglish(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(LAZY_DIR)) return out;
  for (const f of readdirSync(LAZY_DIR).filter((n) => n.endsWith(".json")).sort()) {
    Object.assign(out, JSON.parse(readFileSync(join(LAZY_DIR, f), "utf8")) as Record<string, string>);
  }
  return out;
}
