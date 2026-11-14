/**
 * Plan W2.4 — DictaLM 3.0 in the Hebrew model catalogue: the variant
 * manifest (models/dictalm3.json), its owner checks, the licence gate
 * entries, and the rule that the default changes only on a gain of ≥ 5
 * points (scripts/lib/dictalm3.mjs, scripts/dictalm3.mjs).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  catalogLine,
  decide,
  latestRuns,
  modelScore,
  openChecks,
  scoreRun,
  validateManifest,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/dictalm3.mjs";

const ROOT = resolve(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "models", "dictalm3.json"), "utf8"));
const registry = JSON.parse(readFileSync(join(ROOT, "models", "registry.json"), "utf8")) as { models: Array<Record<string, unknown>> };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

type Case = { id: string; status: string; checks: Array<{ ok: boolean }> };
const run = (model: string, ok: number, total: number, skipped = 0): { model: string; results: Case[] } => ({
  model,
  results: [
    ...Array.from({ length: total }, (_, i) => ({ id: `c${i}`, status: i < ok ? "ok" : "failed", checks: [{ ok: i < ok }] })),
    ...Array.from({ length: skipped }, (_, i) => ({ id: `s${i}`, status: "skipped", checks: [] })),
  ],
});
const ready = (over: Record<string, unknown> = {}) => ({
  ...manifest.variants[0],
  revision: SHA_A,
  ollamaRevision: SHA_B,
  ...over,
});
const files = (rows: Array<[string, unknown]>) => rows.map(([name, json]) => ({ name, json }));

describe("DictaLM 3.0 manifest (W2.4)", () => {
  it("is valid, lists the paper's three sizes and their base models", () => {
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.variants.map((v: { size: string }) => v.size)).toEqual(["1.7B", "12B", "24B"]);
    expect(manifest.variants.map((v: { base: string }) => v.base)).toEqual(["Qwen3-1.7B", "NVIDIA Nemotron Nano V2", "Mistral-Small-3.1"]);
    expect(manifest.minGainPoints).toBe(5);
  });

  it("nothing unverified is filled in: 12B and 24B have no repo and stay blocked", () => {
    for (const v of manifest.variants.slice(1)) {
      expect(v.repo).toBeNull();
      expect(v.ollama).toBeNull();
    }
    const [, v12, v24] = manifest.variants;
    expect(v12.licence).toMatchObject({ name: null, class: "unknown", verified: false });
    expect(openChecks(v12)).toEqual(["repo", "revision", "ollama", "ollamaRevision", "licence"]);
    // W10.B20: the plan's correction (24B Thinking is Apache-2.0 with tool
    // calling, from its model card) is in the data; repo and revisions stay open.
    expect(v24.licence).toMatchObject({ name: "Apache-2.0", class: "allowed", verified: true });
    expect(v24.licence.source).toMatch(/dicta-il\/DictaLM-3\.0-24B-Thinking/);
    expect(v24.licence.source).toMatch(/tool-calling/);
    expect(v24.tools).toBe(false); // stated on the card, not yet measured in Lumen
    expect(openChecks(v24)).toEqual(["repo", "revision", "ollama", "ollamaRevision"]);
    // 1.7B: the licence is the registry's verified one; only the revisions are open.
    expect(openChecks(manifest.variants[0])).toEqual(["revision", "ollamaRevision"]);
  });

  it("matches the licence gate: 1.7B as registered, 12B unknown, 24B allowed, both in no catalog", () => {
    const byId = new Map(registry.models.map((m) => [m.id, m]));
    const gguf = byId.get(manifest.variants[0].ollama);
    expect(gguf).toMatchObject({ license: "Apache-2.0", class: "allowed", verified: true });
    expect(byId.get("DictaLM-3.0-12B")).toMatchObject({ class: "unknown", verified: false, delivery: "none" });
    expect(byId.get("DictaLM-3.0-24B")).toMatchObject({ license: "Apache-2.0", class: "allowed", verified: true, delivery: "none" });
    const catalog = readFileSync(join(ROOT, "src", "ai", "modelCatalog.ts"), "utf8");
    expect(catalog).not.toMatch(/DictaLM-3\.0-(12|24)B/);
  });

  it("rejects a gain below 5 points, a short sha, a non-Dicta repo and a verified licence without a name", () => {
    expect(validateManifest({ ...manifest, minGainPoints: 3 })).toContain("minGainPoints must be a number ≥ 5 (plan W2.4)");
    const bad = (over: Record<string, unknown>) => validateManifest({ ...manifest, variants: [{ ...manifest.variants[0], ...over }] });
    expect(bad({ revision: "abc123" })).toContain("1.7B: revision must be a 40-character commit sha");
    expect(bad({ repo: "someone/DictaLM-3.0-1.7B" })).toContain("1.7B: repo must be an official dicta-il/DictaLM-3.0-* repository");
    expect(bad({ licence: { name: null, class: "unknown", verified: true, source: "" } })).toContain("1.7B: a verified licence needs its name and a known class");
    expect(openChecks(ready({ licence: { name: "x", class: "forbidden", verified: true, source: "" } }))).toEqual(["licence is forbidden — do not include"]);
  });
});

describe("DictaLM 3.0 scoring and the ≥ 5-point rule", () => {
  it("scores a run like eval-compare: passed of the non-skipped cases", () => {
    expect(scoreRun(run("m", 3, 4, 2))).toBe(75);
    expect(scoreRun({ results: [] })).toBeNull();
    expect(scoreRun({ results: [{ id: "x", status: "ok", checks: [{ ok: false }] }] })).toBe(0);
  });

  it("takes the newest run of each kind for the model and averages the kinds", () => {
    const m = "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF";
    const slug = "hf.co_dicta-il_DictaLM-3.0-1.7B-Thinking-GGUF";
    const runs = latestRuns(
      files([
        [`agents-2026-11-01-${slug}.json`, run(m, 1, 10)],
        [`agents-2026-11-05-${slug}.json`, run(m, 8, 10)],
        [`prompts-2026-11-05-${slug}.json`, run(m, 6, 10)],
        [`agents-2026-11-09-qwen3_4b.json`, run("qwen3:4b", 10, 10)],
        [`agents-2026-11-09-${slug}.md`, null],
      ]),
      m,
    );
    expect(modelScore(runs)).toEqual({ agents: 80, prompts: 60, score: 70 });
  });

  const tier = (candOk: number, curOk: number, licence?: Record<string, unknown>) => {
    const v = ready(licence ? { licence } : {});
    const fs = files([
      [`agents-2026-11-10-hf.co_dicta-il_DictaLM-3.0-1.7B-Thinking-GGUF.json`, run(v.ollama, candOk, 1000)],
      [`agents-2026-11-10-qwen3_4b.json`, run("qwen3:4b", curOk, 1000)],
    ]);
    return { v, d: decide(v, fs, 5) };
  };

  it("switches at exactly +5 points, keeps the default at +4.9", () => {
    expect(tier(650, 600).d).toMatchObject({ verdict: "switch", gain: 5 });
    expect(tier(649, 600).d.verdict).toBe("keep");
    expect(tier(500, 600).d.reason).toContain("-10.0 < 5 points");
  });

  it("a conditional licence is only offered, never the default, whatever the gain", () => {
    const { v, d } = tier(900, 100, { name: "NVIDIA Open Model License", class: "conditional", verified: true, source: "test" });
    expect(d.verdict).toBe("offer");
    expect(catalogLine(v, d)).toContain(`licence: { class: "conditional", name: "NVIDIA Open Model License" }, recommend: false`);
  });

  it("blocked and no-results verdicts never propose a catalog line", () => {
    const blocked = decide(manifest.variants[1], [], 5);
    expect(blocked).toMatchObject({ verdict: "blocked" });
    expect(catalogLine(manifest.variants[1], blocked)).toBeNull();
    const none = decide(ready(), [], 5);
    expect(none.verdict).toBe("no-results");
    expect(catalogLine(ready(), none)).toBeNull();
  });

  it("a switch proposes the catalog line with the measured 0–1 score and no recommend: false", () => {
    const { v, d } = tier(820, 700);
    const line = catalogLine(v, d) ?? "";
    expect(line).toContain(`name: "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF"`);
    expect(line).toContain("measured: 0.82");
    expect(line).not.toContain("recommend: false");
  });
});

describe("scripts/dictalm3.mjs", () => {
  const cli = (args: string[], root = ROOT) => spawnSync(process.execPath, [join(ROOT, "scripts", "dictalm3.mjs"), ...args, "--root", root], { encoding: "utf8" });

  it("status lists every size with its open owner checks", () => {
    const r = cli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("12B   base NVIDIA Nemotron Nano V2");
    expect(r.stdout).toContain("⏳ open: repo, revision, ollama, ollamaRevision, licence");
  });

  it("eval refuses a blocked variant without running anything", () => {
    const r = cli(["eval", "--size", "12B"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DictaLM 3.0 12B is blocked");
  });

  it("decide reads eval/results under --root and prints the verdict per size", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictalm3-"));
    try {
      mkdirSync(join(dir, "models"));
      mkdirSync(join(dir, "eval", "results"), { recursive: true });
      const m = { ...manifest, variants: [ready(), ...manifest.variants.slice(1)] };
      writeFileSync(join(dir, "models", "dictalm3.json"), JSON.stringify(m));
      writeFileSync(join(dir, "eval", "results", "agents-2026-11-10-hf.co_dicta-il_DictaLM-3.0-1.7B-Thinking-GGUF.json"), JSON.stringify(run(m.variants[0].ollama, 9, 10)));
      writeFileSync(join(dir, "eval", "results", "prompts-2026-11-10-hf.co_dicta-il_DictaLM-3.0-1.7B-Thinking-GGUF.json"), JSON.stringify(run(m.variants[0].ollama, 8, 10)));
      writeFileSync(join(dir, "eval", "results", "agents-2026-11-10-qwen3_4b.json"), JSON.stringify(run("qwen3:4b", 7, 10)));
      writeFileSync(join(dir, "eval", "results", "prompts-2026-11-10-qwen3_4b.json"), JSON.stringify(run("qwen3:4b", 8, 10)));
      const r = cli(["decide", "--json", "eval/results/dictalm3-decision.json"], dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("1.7B  SWITCH     85.0 vs 75.0 for qwen3:4b: +10.0 ≥ 5 points");
      expect(r.stdout).toContain("12B   BLOCKED");
      const out = JSON.parse(readFileSync(join(dir, "eval", "results", "dictalm3-decision.json"), "utf8"));
      expect(out.decisions.map((x: { verdict: string }) => x.verdict)).toEqual(["switch", "blocked", "blocked"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an invalid manifest fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictalm3-"));
    try {
      mkdirSync(join(dir, "models"));
      writeFileSync(join(dir, "models", "dictalm3.json"), JSON.stringify({ ...manifest, minGainPoints: 1 }));
      const r = cli([], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("minGainPoints must be a number ≥ 5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
