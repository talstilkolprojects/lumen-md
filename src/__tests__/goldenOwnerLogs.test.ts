// @vitest-environment node
/**
 * #225 P1: scripts/golden/owner.mjs runs in a public Actions log, so a
 * malformed owner bundle must fail without printing any of its content:
 * no JSON.parse fragment, no owner ID, no filename.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONSENT = "I dedicate everything in this bundle to the public domain (CC0 1.0).\nName: Test Owner\nDate: 2026-11-10\n";

/** A PCM WAV of silence. */
function wav(channels: number, rate: number, seconds: number): Buffer {
  const data = Math.round(rate * seconds) * channels * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

describe("owner.mjs keeps the owner's material out of the log", () => {
  it("malformed parts fail with the rule or the error type only", () => {
    const base = mkdtempSync(join(tmpdir(), "golden-owner-"));
    try {
      const bundle = join(base, "bundle");
      const part = (set: string, id: string) => {
        const d = join(bundle, set, id);
        mkdirSync(d, { recursive: true });
        return d;
      };
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "CONSENT.md"), CONSENT);
      // A JSON error: Node's message quotes the text around the bad token.
      writeFileSync(join(part("retrieval", "owner"), "queries.json"), '[{"id":"q1","query":"HELDOUT-PROMPT-XYZ" oops}]');
      // A rule error that used to interpolate the owner's ID.
      writeFileSync(join(part("asr-he", "owner"), "transcripts.tsv"), "SECRET-SPEAKER-ID\tשלום\n");
      writeFileSync(join(part("injection", "hebrew"), "hebrew.json"), JSON.stringify([{ id: "SECRET-CASE", vector: "nope" }]));
      const r = spawnSync(process.execPath, ["scripts/golden/owner.mjs", "--in", bundle, "--out", join(base, "out")], { encoding: "utf8" });
      const log = `${r.stdout}\n${r.stderr}`;
      expect(r.status).toBe(1);
      for (const secret of ["HELDOUT-PROMPT-XYZ", "oops", "SECRET-SPEAKER-ID", "SECRET-CASE"]) expect(log).not.toContain(secret);
      expect(log).toContain("retrieval/owner: a JSON file of the part is not valid JSON");
      expect(log).toContain("asr-he/owner: every transcript line needs an audio file and a transcript");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a CONSENT.md without the dedication, a name and a date stops everything (W1.32, #225)", () => {
    const base = mkdtempSync(join(tmpdir(), "golden-owner-"));
    try {
      const bundle = join(base, "bundle");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "CONSENT.md"), "SECRET-OWNER-NAME agrees\n");
      const r = spawnSync(process.execPath, ["scripts/golden/owner.mjs", "--in", bundle, "--out", join(base, "out")], { encoding: "utf8" });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('CONSENT.md must hold the CC0 1.0 public-domain dedication, a "Name: …" line and a "Date: YYYY-MM-DD" line');
      expect(`${r.stdout}${r.stderr}`).not.toContain("SECRET-OWNER-NAME");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("checks the ASR recordings' format and the injection vectors' split, naming only the rule (W1.32, #225)", () => {
    const base = mkdtempSync(join(tmpdir(), "golden-owner-"));
    try {
      const bundle = join(base, "bundle");
      const part = (set: string, id: string) => {
        const d = join(bundle, set, id);
        mkdirSync(d, { recursive: true });
        return d;
      };
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "CONSENT.md"), CONSENT);
      const asr = part("asr-he", "owner");
      writeFileSync(join(asr, "transcripts.tsv"), "SECRET-CLIP\tשלום\n");
      writeFileSync(join(asr, "SECRET-CLIP.wav"), wav(2, 16000, 6)); // stereo
      // 30 cases, all one vector: the right size, the wrong benchmark.
      const cases = Array.from({ length: 30 }, (_, i) => ({ id: `SECRET-${i}`, vector: "html-comment", carrier: "c", user_task: "t", injected: "i" }));
      writeFileSync(join(part("injection", "hebrew"), "hebrew.json"), JSON.stringify(cases));
      const r = spawnSync(process.execPath, ["scripts/golden/owner.mjs", "--in", bundle, "--out", join(base, "out")], { encoding: "utf8" });
      const log = `${r.stdout}\n${r.stderr}`;
      expect(r.status).toBe(1);
      expect(log).toContain("asr-he/owner: every recording must be mono");
      expect(log).toContain("injection/hebrew: the cases must be split evenly over the 5 vectors (6 each for 30)");
      expect(log).not.toContain("SECRET");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
