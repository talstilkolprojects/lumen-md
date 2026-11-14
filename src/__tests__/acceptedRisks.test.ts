/**
 * Plan W9.5: every low or info finding of reviews 6–34 is fixed with a test or
 * written into docs/security/accepted-risks.md with why it is accepted and what
 * mitigates it. This keeps the page whole: each accepted id is in both the
 * English and the Hebrew part, and each entry says why and what mitigates it.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const doc = readFileSync(join(__dirname, "..", "..", "docs", "security", "accepted-risks.md"), "utf8");
const [en, he] = doc.split(/\n---\n/);

/** The findings W9.5 accepted rather than fixed (the PR's table lists the fixed ones and their tests). */
const ACCEPTED = [
  "rr7-4(a) / G4", "rr9-1(c) / H2", "rr9-2(b) / H4", "RR6-469-3", "V2",
  "RR18-469-2", "M2", "B1r", "R12-15", "RR2-483-5", "RR8-469-5", "RR20-596-3", "RR20-596-4", "RR20-596-5",
  "X6 / RR11-451-2", "RR6-451-2 E7", "Z3", "S2", "S4 / T6", "Z2", "Z4", "Q3", "R4", "H5", "K6-4",
  "RR8-473-3", "C1", "C2", "C4", "D1", "RR30", "RR25", "RR23-587-3", "T5-1",
  "RR11-473-1", "RR14-469-3", "RR18-469-3", "S13-3", "S27-3", "S27-4", "S13-4", "N3",
];

describe("accepted risks (plan W9.5)", () => {
  it("has an English and a Hebrew part", () => {
    expect(he).toBeDefined();
    expect(en).toMatch(/^# Accepted risks/);
    expect(he.trim()).toMatch(/^# סיכונים מקובלים/);
  });

  it("names every accepted finding in both parts", () => {
    expect(ACCEPTED.filter((id) => !en.includes(id))).toEqual([]);
    expect(ACCEPTED.filter((id) => !he.includes(id))).toEqual([]);
  });

  it("gives every entry a reason and a mitigation, in both parts", () => {
    const entries = (part: string) => part.split("\n- **").slice(1);
    for (const e of entries(en)) expect(e, e.slice(0, 60)).toMatch(/\*Why:\*[\s\S]*\*Mitigation:\*/);
    for (const e of entries(he)) expect(e, e.slice(0, 60)).toMatch(/\*למה:\*[\s\S]*\*מה\s+מצמצם:\*/);
    expect(entries(en).length).toBe(entries(he).length);
  });
});
