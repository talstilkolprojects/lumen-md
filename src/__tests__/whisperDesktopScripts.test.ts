/**
 * Plan W1.17 — the owner tools for desktop Whisper (scripts/whisper-desktop.mjs):
 * SRT parsing (the same rule as src-tauri/src/whisper_core.rs), the pin
 * check and the speed report.
 */
import { describe, it, expect } from "vitest";
import {
  parseSrt,
  pinSnippet,
  speedReport,
  srtTime,
  validatePin,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/whisper-desktop.mjs";

const PIN = { repo: "example-owner/ggml-he", revision: "c".repeat(40), file: "ggml-model.bin", bytes: 1_624_555_275, sha256: "d".repeat(64) };

describe("whisper-desktop owner tools (W1.17)", () => {
  it("parses whisper-cli SRT like the Rust side", () => {
    expect(srtTime("01:02:03,004")).toBe(3_723_004);
    expect(srtTime("00:61:00,000")).toBeNull();
    const srt = "1\r\n00:00:00,000 --> 00:00:02,500\r\n שלום לכולם.\r\n\r\n2\n00:00:02,500 --> 00:01:03,040\nהיום נדבר\nעל תקציב.\n\n3\n00:01:03,040 --> 00:01:04,000\n\n";
    expect(parseSrt(srt)).toEqual([
      { startMs: 0, endMs: 2500, text: "שלום לכולם." },
      { startMs: 2500, endMs: 63_040, text: "היום נדבר על תקציב." },
    ]);
  });

  it("pins only a full, well-formed set of values", () => {
    expect(validatePin(PIN)).toEqual([]);
    expect(validatePin({ ...PIN, revision: "main" })).toEqual(["--revision must be a 40-character commit sha (not a branch)"]);
    expect(validatePin({ ...PIN, file: "../ggml.bin", bytes: 0 })).toHaveLength(2);
    const snippet = pinSnippet(PIN);
    expect(snippet).toContain(`revision: "${"c".repeat(40)}",`);
    expect(snippet).toContain("bytes: 1624555275,");
  });

  it("speed: real-time factor and minutes per hour against the < 10 min target", () => {
    expect(speedReport(6 * 60_000, 60 * 60_000)).toEqual({ rtf: 0.1, minutesPerHour: 6, underTarget: true });
    expect(speedReport(12 * 60_000, 60 * 60_000)).toEqual({ rtf: 0.2, minutesPerHour: 12, underTarget: false });
    expect(speedReport(1, 0)).toEqual({ rtf: null, minutesPerHour: null, underTarget: false });
  });
});
