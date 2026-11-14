/**
 * T31 × T37 — the OCR language models are served from this origin (plan 7.5),
 * so starting OCR makes no outside request for the privacy ledger to record.
 */
import { describe, it, expect } from "vitest";
import { langPath } from "../ai/ocr";

describe("OCR language models", () => {
  it("are fetched from this origin, under tesseract/lang", () => {
    const u = new URL(langPath());
    expect(u.origin).toBe(location.origin);
    expect(u.pathname).toMatch(/\/tesseract\/lang$/);
  });
});
