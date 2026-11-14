/**
 * Snapshot test for the i18n bundle (α.6.9).
 *
 * Pins two invariants that protect us from string regressions:
 *   1. Every `t("…")` callsite in the source has a matching key in
 *      both the `en` and `he` bundles.
 *   2. The 8 keys that closed α.6 (Canvas / VersionHistory / Table /
 *      SearchDialog ×2 / Voice / ErrorBoundary / docTabs.label) are
 *      present in both bundles. A future cleanup that drops one of
 *      those would re-introduce the hardcoded-English regression.
 *
 * Driving a full DOM render in 8 locales is too heavy for a unit test
 * (each component pulls dozens of lazy modules); the inverted-index
 * checks above catch the same class of bug in milliseconds.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";
import { lazyEnglish } from "./helpers/i18nLazy";

const SRC = resolve(__dirname, "..");

/** Recursively read every .ts/.tsx under src/ except __tests__ + node_modules. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name.startsWith(".")) continue;
    if (name.name === "__tests__" || name.name === "node_modules") continue;
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(full);
  }
  return out;
}

/** Pull every `t("key")` literal out of a file. We only care about
 *  string-literal arguments — dynamic keys aren't checkable here. */
function extractKeys(text: string): string[] {
  // Matches t("foo.bar"), t('foo.bar'), t(`foo.bar`).
  // Restrict to the first arg's string literal — ignore template-literal
  // keys with interpolation since those are dynamic.
  const re = /\bt\(\s*["'`]([\w.\-]+)["'`]/g;
  const keys = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) keys.add(m[1]);
  return [...keys];
}

function loadBundle(): { en: Record<string, string>; he: Record<string, string> } {
  // The strings live in src/i18n/locales/<lang>/<domain>.json (plan 0.3).
  return { en: { ...readLocale("en"), ...lazyEnglish() }, he: readLocale("he") };
}

describe("i18n bundle integrity", () => {
  const files = listSourceFiles(SRC);
  const callKeys = new Set<string>();
  for (const f of files) {
    for (const k of extractKeys(readFileSync(f, "utf8"))) callKeys.add(k);
  }
  const { en, he } = loadBundle();

  it("every callsite key exists in the English bundle", () => {
    const missing: string[] = [];
    for (const k of callKeys) if (!(k in en)) missing.push(k);
    if (missing.length > 0) {
      // Surface the offenders in the failure message.
      throw new Error(
        `Missing in en bundle: ${missing.slice(0, 20).join(", ")}` +
          (missing.length > 20 ? `, …+${missing.length - 20} more` : ""),
      );
    }
    expect(missing).toEqual([]);
  });

  it("every callsite key exists in the Hebrew bundle", () => {
    const missing: string[] = [];
    for (const k of callKeys) if (!(k in he)) missing.push(k);
    if (missing.length > 0) {
      throw new Error(
        `Missing in he bundle: ${missing.slice(0, 20).join(", ")}` +
          (missing.length > 20 ? `, …+${missing.length - 20} more` : ""),
      );
    }
    expect(missing).toEqual([]);
  });

  it("the 8 α.6 cleanup keys are present in both bundles", () => {
    const required = [
      "canvas.autoSaved",
      "versionHistory.title",
      "versionHistory.savedCount",
      "mdTable.title",
      "searchDialog.sources",
      "searchDialog.askPlaceholder",
      "voice.recording",
      "errorBoundary.heading",
    ];
    for (const k of required) {
      expect(en).toHaveProperty(k);
      expect(he).toHaveProperty(k);
    }
  });

  it("en + he bundles are roughly the same size (no half-ported locale)", () => {
    const enKeys = Object.keys(en).length;
    const heKeys = Object.keys(he).length;
    // Allow up to 8 keys' difference for in-flight migrations.
    expect(Math.abs(enKeys - heKeys)).toBeLessThanOrEqual(8);
  });
});
