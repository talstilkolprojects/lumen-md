import { describe, expect, it } from "vitest";
import {
  HOB_TOTAL_IMAGES,
  HOB_TRACKS,
  bidiCheck,
  bidiRegressions,
  gaps,
  isInside,
  leakedImages,
  listPackage,
  normalizePrediction,
  packageCoverage,
  predictionLine,
  reversedWords,
  submissionMeta,
  trackOf,
  validateScoreRecord,
  type ScoreRecord,
} from "../ai/hebocrbench";
import results from "../../eval/external/hebocrbench.json";

const record = (over: Partial<ScoreRecord> = {}): ScoreRecord => ({
  date: "2026-12-01",
  version: "0.2.0",
  commit: "ad415c29a3",
  submission: "sub-1",
  scores: HOB_TRACKS.map((t) => ({ track: t.id, metric: "CER", value: 0.05 })),
  ...over,
});

describe("HebOCRBench kit (W7.12)", () => {
  it("five tracks, 34,267 images, as published", () => {
    expect(HOB_TRACKS.map((t) => t.id)).toEqual(["bidi", "lines", "pages", "tables", "robustness"]);
    expect(HOB_TOTAL_IMAGES).toBe(34_267);
  });

  it("an image's track comes from its folder, whatever the package calls it", () => {
    expect(trackOf("lines/000123.png")).toBe("lines");
    expect(trackOf("HebOCRBench/Tables/t-01.jpg")).toBe("tables");
    expect(trackOf("v1/bidi/a/b.png")).toBe("bidi");
    expect(trackOf("robustness/blur/3/x.png")).toBe("robustness");
    expect(trackOf("Page/p1.tif")).toBe("pages");
    expect(trackOf("misc/x.png")).toBeNull();
    expect(trackOf("lines.png")).toBeNull();
  });

  it("the package lists by track with ids relative to the track folder; other files are ignored or reported", () => {
    const { items, unknown, perTrack } = listPackage(["lines/b.png", "lines/a.png", "README.md", "robustness/blur/1.jpg", "x/y.png", "pages/p1.png", "lines/gold.json"]);
    expect(items.map((i) => `${i.track}:${i.id}`)).toEqual(["lines:a", "lines:b", "pages:p1", "robustness:blur/1"]);
    expect(unknown).toEqual(["x/y.png"]);
    expect(perTrack).toEqual({ bidi: 0, lines: 2, pages: 1, tables: 0, robustness: 1 });
    expect(packageCoverage(perTrack).find((c) => c.track === "lines")).toEqual({ track: "lines", found: 2, expected: 28_414, complete: false });
  });

  it("a prediction is NFC, in logical order, without direction marks, and trimmed", () => {
    const decomposed = "שׁלום"; // shin + shin dot: NFC keeps it, but the line is normalised
    expect(normalizePrediction(` ‏שלום‎ world \r\nשורה\t \n\n`)).toBe(" שלום world\nשורה");
    expect(normalizePrediction("a‫b‬c⁧d⁩")).toBe("abcd");
    expect(normalizePrediction("‏x", { keepMarks: true })).toBe("‏x");
    expect(normalizePrediction(decomposed)).toBe(decomposed.normalize("NFC"));
    expect(JSON.parse(predictionLine({ id: "a/1", track: "bidi" }, "שלום ABC‎\n"))).toEqual({ id: "a/1", track: "bidi", prediction: "שלום ABC" });
  });

  it("submission metadata names the system, the commit and the models, and labels a partial run", () => {
    const m = submissionMeta({ version: "0.2.0", commit: "abc1234", date: "2026-12-01", engine: "tesseract.js 7", models: { "heb.traineddata.gz": "00" }, perTrack: { bidi: 192, lines: 28_414, pages: 700, tables: 61, robustness: 4_900 } });
    expect(m.system).toBe("lumen-md");
    expect(m.notes).toEqual([]);
    expect(m.tracks.reduce((n, t) => n + t.predictions, 0)).toBe(HOB_TOTAL_IMAGES);
    const p = submissionMeta({ version: "0.2.0", commit: "abc1234", date: "2026-12-01", engine: "x", models: {}, perTrack: { bidi: 5, lines: 0, pages: 0, tables: 0, robustness: 0 } });
    expect(p.notes[0]).toMatch(/^partial run: bidi 5\/192, lines 0\/28414/);
  });

  it("the package never sits in the repo, and no package image reaches the repo or dist", () => {
    expect(isInside("/home/u/lumen-md/eval/x", "/home/u/lumen-md")).toBe(true);
    expect(isInside("/home/u/lumen-md", "/home/u/lumen-md/")).toBe(true);
    expect(isInside("/home/u/lumen-md-data/x", "/home/u/lumen-md")).toBe(false);
    expect(leakedImages(new Set(["aa", "bb"]), [{ path: "public/a.png", sha256: "cc" }, { path: "dist/b.png", sha256: "bb" }])).toEqual(["dist/b.png"]);
    expect(leakedImages(new Set(["aa"]), [])).toEqual([]);
  });

  it("a score is published only with a date, a version, a commit and one score per track", () => {
    expect(validateScoreRecord(record())).toEqual([]);
    const errs = validateScoreRecord(record({ date: "1.12", version: "", scores: [{ track: "bidi", metric: "CER", value: 1.5 }] }));
    expect(errs).toContain("date must be YYYY-MM-DD");
    expect(errs).toContain("version is required");
    expect(errs).toContain("bidi: value 1.5 is not a fraction");
    expect(errs).toContain("lines: 0 scores, need exactly 1");
  });

  it("a gap of more than 5 points between internal and external CER opens a fix task; no internal number, no comparison", () => {
    const r = record({ scores: HOB_TRACKS.map((t) => ({ track: t.id, metric: "CER", value: t.id === "lines" ? 0.0737 : 0.02 })) });
    const g = gaps(r, { lines: 0.0137, pages: 0.0096 });
    expect(g.map((x) => [x.track, x.points, x.openFixTask])).toEqual([
      ["lines", 6, true],
      ["pages", 1.04, false],
    ]);
    expect(gaps(r, {})).toEqual([]);
  });

  it("the bidi track checks: direction marks and reversed Hebrew words (W5.4, W5.5)", () => {
    expect(reversedWords("שלום עולם")).toEqual([]);
    expect(reversedWords("םולש םלוע")).toEqual(["םולש", "םלוע"]);
    expect(reversedWords("ךרד")).toEqual(["ךרד"]);
    expect(reversedWords("דרכ")).toEqual(["דרכ"]);
    expect(bidiCheck("x", "שלום‏")).toEqual({ id: "x", marks: 1, reversed: [] });
    const before = [{ id: "1", track: "bidi" as const, prediction: "שלום ABC" }, { id: "2", track: "bidi" as const, prediction: "םולש" }];
    const after = [{ id: "1", track: "bidi" as const, prediction: "םולש ABC" }, { id: "2", track: "bidi" as const, prediction: "םולש" }, { id: "3", track: "lines" as const, prediction: "םולש" }];
    const r = bidiRegressions(before, after);
    expect(r.changed).toEqual(["1"]);
    expect(r.newFailures.map((f) => f.id)).toEqual(["1"]);
  });

  it("the published results file holds only valid records", () => {
    expect(Array.isArray(results.records)).toBe(true);
    for (const r of results.records as ScoreRecord[]) expect(validateScoreRecord(r)).toEqual([]);
  });
});
