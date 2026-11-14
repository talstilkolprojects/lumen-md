/**
 * i18n placeholder integrity test.
 *
 * Translators sometimes drop `{var}` placeholders or wrap them in
 * locale-native quotes — a UI calling `t("key", { var: "X" })` then
 * shows literal `{var}` instead of "X". This test asserts that every
 * key whose English value carries placeholders also carries the same
 * set of placeholders in Hebrew (`locales/he.json`).
 *
 * Lazy-loaded JSON locales (ar, ru, fr, de, ja, zh-CN) ship as `{}`
 * placeholder stubs at the moment, so they're skipped — they're
 * checked separately the moment any of them gets a real translation
 * landed via `scripts/translate-locale.mjs`.
 */

import { describe, it, expect } from "vitest";
import { lazyEnglish } from "./helpers/i18nLazy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "..", "i18n", "index.ts");
const text = readFileSync(SRC, "utf8");

interface Bundle {
  [key: string]: string;
}

function extractBundle(name: string): Bundle {
  const re = new RegExp(
    `const ${name}:\\s*Strings\\s*=\\s*\\{([\\s\\S]+?)^\\};`,
    "m",
  );
  const match = re.exec(text);
  if (!match) throw new Error(`Could not isolate the \`${name}\` bundle`);
  const body = match[1];
  const out: Bundle = {};
  const entryRe = /^\s*"([\w.\-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/gm;
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    out[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

const en = { ...extractBundle("en"), ...lazyEnglish() };
// Hebrew moved to a lazy JSON chunk (A7 lever 4) — read it from disk.
const he: Bundle = JSON.parse(
  readFileSync(resolve(__dirname, "..", "i18n", "locales", "he.json"), "utf8"),
);

function placeholders(s: string): Set<string> {
  return new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

describe("i18n placeholder integrity", () => {
  it("every key with placeholders in en has them in he too", () => {
    const drift: { key: string; en: string; he: string }[] = [];
    for (const key of Object.keys(en)) {
      const enPh = placeholders(en[key]);
      if (enPh.size === 0) continue;
      const heVal = he[key];
      if (heVal === undefined) continue; // missing-key check is in i18nStrings
      const hePh = placeholders(heVal);
      const missing = [...enPh].filter((p) => !hePh.has(p));
      if (missing.length > 0) {
        drift.push({ key, en: en[key], he: heVal });
      }
    }
    if (drift.length > 0) {
      // Surface each offender at the top level so the failure message
      // is actionable.
      const pretty = drift
        .slice(0, 10)
        .map(
          (d) => `  ${d.key}\n    en: ${d.en}\n    he: ${d.he}`,
        )
        .join("\n");
      throw new Error(
        `Placeholder drift in ${drift.length} key(s):\n${pretty}` +
          (drift.length > 10 ? `\n  …+${drift.length - 10} more` : ""),
      );
    }
    expect(drift).toEqual([]);
  });

  it("no key in he introduces a placeholder that wasn't in en (typo / pasted-in)", () => {
    const extras: { key: string; he: string }[] = [];
    for (const key of Object.keys(en)) {
      const enPh = placeholders(en[key]);
      const heVal = he[key];
      if (!heVal) continue;
      const hePh = placeholders(heVal);
      for (const p of hePh) {
        if (!enPh.has(p)) {
          extras.push({ key, he: heVal });
          break;
        }
      }
    }
    expect(extras).toEqual([]);
  });

  it("known plural-style keys carry the documented placeholders", () => {
    // Smoke-check a few high-traffic keys to lock the contract.
    expect(placeholders(en["status.words"])).toContain("n");
    expect(placeholders(he["status.words"])).toContain("n");
    expect(placeholders(en["templates.installed"])).toContain("name");
    expect(placeholders(en["templates.installed"])).toContain("path");
  });
});
