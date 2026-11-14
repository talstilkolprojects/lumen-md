/**
 * English strings of lazily loaded domains (src/i18n/lazy/<domain>.json).
 * They ship with their domain's chunk instead of the startup bundle and are
 * registered at runtime with `registerEnglish()` (src/i18n/index.ts); every
 * i18n tool reads them together with the `en` block of src/i18n/index.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** [key, english] pairs, files in name order, keys in file order. */
export function lazyEnglishEntries(root = process.cwd()) {
  const dir = resolve(root, "src/i18n/lazy");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    out.push(...Object.entries(JSON.parse(readFileSync(join(dir, f), "utf8"))));
  }
  return out;
}
