/**
 * A language's startup strings as one flat map. The locale files were split
 * into domain files (src/i18n/locales/<lang>/*.json, plan W2.x i18n split), so a
 * test that used to read src/i18n/locales/<lang>.json reads them all here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function localeStrings(lang: string, root: string = resolve(__dirname, "..", "..", "..")): Record<string, string> {
  const dir = join(root, "src/i18n/locales", lang);
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) Object.assign(out, JSON.parse(readFileSync(join(dir, f), "utf8")));
  return out;
}
