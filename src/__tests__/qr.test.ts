/**
 * The QR encoder of the LAN pairing codes (plan W2.19). Decoding was checked
 * against OpenCV's QR detector when the encoder was written; here, the parts
 * of the symbol the standard fixes.
 */
import { describe, expect, it } from "vitest";
import { encodeQr, qrPath, QrTooLongError, reedSolomon } from "../lib/qr";

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

  /*
   * Published vectors (W10.C20), not computed by this encoder:
   *  - ISO/IEC 18004 Annex I, the worked example "01234567" at 1-M: its 16
   *    data codewords and the 10 error-correction codewords the standard lists;
   *  - the "HELLO WORLD" 1-M example of the widely used Thonky QR tutorial
   *    (thonky.com/qr-code-tutorial), same shape;
   *  - the standard's format-information table (Annex C, level M, masks
   *    0–7) and version-information table (Annex D, version 7).
   */
  it("Reed–Solomon matches the standard's worked examples", () => {
    expect(reedSolomon([16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17], 10)).toEqual([165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
    expect(reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("the format information is the standard's table (level M, every mask)", () => {
    const TABLE_M = ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
    for (let mask = 0; mask < 8; mask++) {
      const { modules: m, size } = encodeQr("lumen", "M", mask);
      const at = (x: number, y: number) => (m[y][x] ? "1" : "0");
      // Copy 1, around the top-left finder: bits 0–5 down column 8, then (8,7), (8,8), (7,8), then bits 9–14 along row 8.
      const bits: string[] = [];
      for (let i = 0; i <= 5; i++) bits[i] = at(8, i);
      bits[6] = at(8, 7);
      bits[7] = at(8, 8);
      bits[8] = at(7, 8);
      for (let i = 9; i < 15; i++) bits[i] = at(14 - i, 8);
      expect(bits.reverse().join(""), `mask ${mask}`).toBe(TABLE_M[mask]);
      // Copy 2: bits 0–7 along row 8 from the right edge, bits 8–14 up column 8 from the bottom.
      const two: string[] = [];
      for (let i = 0; i < 8; i++) two[i] = at(size - 1 - i, 8);
      for (let i = 8; i < 15; i++) two[i] = at(8, size - 15 + i);
      expect(two.reverse().join(""), `mask ${mask}, copy 2`).toBe(TABLE_M[mask]);
    }
  });

  it("the version information is the standard's table (version 7)", () => {
    const q = encodeQr("x".repeat(120), "M");
    expect(q.version).toBe(7);
    const bits: string[] = [];
    for (let i = 0; i < 18; i++) bits[i] = q.modules[Math.floor(i / 3)][q.size - 11 + (i % 3)] ? "1" : "0";
    expect(bits.reverse().join("")).toBe("000111110010010100");
  });
});

