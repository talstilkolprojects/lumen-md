/**
 * The reading options' English (src/i18n/lazy/reading.json) ships with
 * their lazy chunk, not the startup bundle (plan W3.5).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { t } from "../i18n";

const SRC = resolve(__dirname, "..");
const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "reading.json"), "utf8")) as Record<string, string>;

describe("i18n: the reading options' lazy English", () => {
  it("has only reading.* keys, none of them in the startup bundle", () => {
    const index = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");
    expect(Object.keys(lazy).length).toBeGreaterThan(15);
    for (const k of Object.keys(lazy)) {
      expect(k.startsWith("reading."), k).toBe(true);
      expect(index.includes(`"${k}":`), k).toBe(false);
    }
  });

  it("registers when the strings module loads", async () => {
    expect(t("reading.title")).toBe("reading.title");
    await import("../reading/strings");
    expect(t("reading.title")).toBe(lazy["reading.title"]);
    expect(t("reading.font.download", { kb: 29 })).toBe("29 KB download");
  });
});
