/**
 * `npm run flags:check` (plan 14.4) on this repo. The flags' English strings
 * live in a lazy domain (src/i18n/lazy/featureFlagsPanel.json) since the
 * lazy-strings work; the script read only src/i18n/locales/en and failed on
 * every flag (audit item 7, train 5).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

describe("flags:check", () => {
  it("passes on the repository: every flag's name and description is found, lazy domains included", () => {
    const r = spawnSync(process.execPath, ["scripts/check-flags.mjs"], { cwd: ROOT, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/feature flags: \d+ flag\(s\)/);
  });

  it("the flag strings it checks are the lazy English ones", () => {
    const lazy = JSON.parse(readFileSync(join(ROOT, "src/i18n/lazy/featureFlagsPanel.json"), "utf8")) as Record<string, string>;
    const flags = (JSON.parse(readFileSync(join(ROOT, "src/flags/flags.json"), "utf8")) as { flags: Array<{ id: string }> }).flags;
    for (const f of flags) {
      expect(lazy[`flag.${f.id}.name`], f.id).toBeTruthy();
      expect(lazy[`flag.${f.id}.desc`], f.id).toBeTruthy();
    }
  });
});
