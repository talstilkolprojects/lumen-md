/**
 * The QR encoder of the LAN pairing codes (plan W2.19). Decoding was checked
 * against OpenCV's QR detector when the encoder was written; here, the parts
 * of the symbol the standard fixes.
 */
import { describe, expect, it } from "vitest";
import { encodeQr, qrPath, QrTooLongError } from "../lib/qr";

const finderAt = (m: boolean[][], x: number, y: number) => {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m[y + dy][x + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
};

describe("QR encoder", () => {
  it("picks the smallest version that holds the data, with the standard's size", () => {
    expect(encodeQr("HELLO WORLD", "M").version).toBe(1);
    expect(encodeQr("x".repeat(14), "M").version).toBe(1); // 14 bytes: the most version 1-M holds
    expect(encodeQr("x".repeat(15), "M").version).toBe(2);
    const code = `lumen-lan:1:z${"A".repeat(480)}`;
    const q = encodeQr(code, "M");
    expect(q.size).toBe(q.version * 4 + 17);
    expect(q.modules.length).toBe(q.size);
  });

  it("draws the finder patterns, the timing patterns and the dark module", () => {
    for (const text of ["a", "x".repeat(200), "y".repeat(1000)]) {
      const { modules: m, size, version } = encodeQr(text, "M");
      expect(finderAt(m, 0, 0) && finderAt(m, size - 7, 0) && finderAt(m, 0, size - 7)).toBe(true);
      for (let i = 8; i < size - 8; i++) {
        expect(m[6][i]).toBe(i % 2 === 0);
        expect(m[i][6]).toBe(i % 2 === 0);
      }
      expect(m[size - 8][8]).toBe(true);
      expect(version).toBeGreaterThan(0);
    }
  });

  it("is deterministic, takes UTF-8, refuses too much data, and renders a path", () => {
    expect(encodeQr("שלום", "Q").modules).toEqual(encodeQr(new TextEncoder().encode("שלום"), "Q").modules);
    expect(() => encodeQr("z".repeat(3000), "H")).toThrow(QrTooLongError);
    const q = encodeQr("lumen", "L");
    const dark = q.modules.flat().filter(Boolean).length;
    expect(qrPath(q).split("M").length - 1).toBe(dark);
  });
});
