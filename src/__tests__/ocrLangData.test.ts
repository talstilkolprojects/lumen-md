/**
 * Plan 7.5 — the committed OCR language models (public/tesseract/lang/) are
 * exactly tesseract-ocr/tessdata_fast at the pinned commit, gzipped, with
 * the Apache-2.0 text beside them, and models/registry.json says so.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(__dirname, "..", "..");
const DIR = join(ROOT, "public", "tesseract", "lang");
const COMMIT = "87416418657359cb625c412a48b6e1d6d41c29bd";
/** sha256 of the upstream (uncompressed) files at COMMIT. */
const UPSTREAM: Record<string, string> = {
  heb: "11f9e43ab227f786352a50f75c94c2e9906f1baba86d93276da19da7ce0904db",
  eng: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
};

describe("OCR language data in public/tesseract/lang", () => {
  it.each(Object.keys(UPSTREAM))("%s.traineddata.gz is the pinned tessdata_fast file", (lang) => {
    const gz = readFileSync(join(DIR, `${lang}.traineddata.gz`));
    expect([gz[0], gz[1]]).toEqual([0x1f, 0x8b]);
    expect(createHash("sha256").update(gunzipSync(gz)).digest("hex")).toBe(UPSTREAM[lang]);
  });

  it("ships the Apache-2.0 licence text with it", () => {
    expect(existsSync(join(DIR, "LICENSE"))).toBe(true);
    expect(readFileSync(join(DIR, "LICENSE"), "utf8")).toMatch(/Apache License\s+Version 2\.0, January 2004/);
  });

  it("the registry entries are bundled, Apache-2.0 and pinned to the same commit and hashes", () => {
    const reg = JSON.parse(readFileSync(join(ROOT, "models", "registry.json"), "utf8")) as {
      models: Array<{ id: string; license: string; delivery?: string; source: string; notes: string }>;
    };
    for (const [lang, sha] of Object.entries(UPSTREAM)) {
      const e = reg.models.find((m) => m.id === `tessdata_fast/${lang}.traineddata`);
      expect(e?.license).toBe("Apache-2.0");
      expect(e?.delivery).toBe("bundled");
      expect(e?.source).toContain(COMMIT);
      expect(e?.notes).toContain(sha);
    }
  });
});
