/**
 * W8.4 — the browser CER gate and the Zotero write check's own logic (their
 * real runs are an owner session: tesseract.js in Chromium, and a real
 * Zotero test library).
 */
import { describe, expect, it } from "vitest";
import { browserGate } from "../../scripts/ocr/scanned-he/browser-cer.mjs";
import { compareBack, fakeLibrary, sampleAnnotations } from "../../scripts/zotero/write-test.mjs";
import { sendAnnotations, toZoteroAnnotation } from "../citations/zoteroAnnotations";

describe("W8.4", () => {
  it("the browser may be at most one point worse than the CLI", () => {
    expect(browserGate(0.1353, 0.1353)).toEqual({ gap: 0, pass: true });
    expect(browserGate(0.1452, 0.1353)).toEqual({ gap: 0.99, pass: true });
    expect(browserGate(0.1454, 0.1353)).toEqual({ gap: 1.01, pass: false });
    expect(browserGate(0.1, 0.1353).pass).toBe(true);
  });

  it("write, read back identical, resend creates nothing (against the in-memory library)", async () => {
    const lib = fakeLibrary(7, "PARENT01");
    const anns = sampleAnnotations("abcdef12-run");
    const first = await sendAnnotations({ call: lib.call, userID: 7, parentItem: "PARENT01", annotations: anns, pageHeights: [842, 842], sentFile: { v: 1, sent: {} }, consent: true });
    expect(first.sent).toBe(3);
    const sent = anns.map((a) => toZoteroAnnotation(a, "PARENT01", 842)).filter((x): x is NonNullable<typeof x> => !!x);
    expect(compareBack(sent, [...lib.items.values()])).toEqual([]);
    const second = await sendAnnotations({ call: lib.call, userID: 7, parentItem: "PARENT01", annotations: anns, pageHeights: [842, 842], sentFile: first.sentFile, consent: true });
    expect([second.sent, lib.items.size]).toEqual([0, 3]);
    // A field Zotero changed, or a duplicate, is reported.
    const changed = [...lib.items.values()].map((x, i) => (i === 0 ? { ...x, annotationComment: "x" } : x));
    expect(compareBack(sent, changed)[0]).toMatch(/^annotationComment/);
    expect(compareBack(sent, [...lib.items.values(), [...lib.items.values()][1]])[0]).toMatch(/found 2 times/);
  });
});
