// @vitest-environment node
/**
 * Plan W4.6 — the real models day (scripts/models-day.mjs): the step list and
 * its plan coverage, the install checklist with exact model tags, resume,
 * the metrics read back from each eval's files, and the receipt. The last
 * case runs the command end to end against the fake Ollama
 * (scripts/fake-ollama.mjs): a wiring run, never a model score.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COVERAGE,
  STEPS,
  agentsMetrics,
  artifacts,
  asrMetrics,
  availability,
  checklist,
  compareVersions,
  declaredMinutes,
  formatReport,
  judge,
  ndcgAt,
  pendingSteps,
  pdfChatMetrics,
  seal,
  selectSteps,
  verifyReport,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/lib/modelsDay.mjs";

type Step = { id: string; plan: string[]; minutes: number; optional?: boolean; models: string[]; needs?: string[]; requires: { script?: string; file?: string }; providedBy?: string; target?: { metric: string; min?: number; max?: number } };
type Item = { ok: boolean; text: string; fix: string };
const steps = STEPS as Step[];
const tmp = () => mkdtempSync(join(tmpdir(), "models-day-"));

describe("the steps", () => {
  it("have unique ids, a plan id each, and the core run is declared within 3 hours", () => {
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    for (const s of steps) {
      expect(s.plan.length, s.id).toBeGreaterThan(0);
      expect(s.minutes, s.id).toBeGreaterThan(0);
    }
    // plan W4.6: "≤ 3 hours on a 12 GB GPU" for everything that runs by default
    expect(declaredMinutes(selectSteps(steps))).toBeLessThanOrEqual(180);
  });

  it("cover the four owner items and every owed AI task, or say why not", () => {
    const planned = new Set(steps.flatMap((s) => s.plan));
    for (const id of ["7.9", "15.3", "15.14", "15.17"]) expect(planned.has(id), id).toBe(true);
    const ids = new Set(steps.map((s) => s.id));
    for (const c of COVERAGE as Array<{ task: string; step: string | null; note: string }>) {
      if (c.step) expect(ids.has(c.step), `${c.task} → ${c.step}`).toBe(true);
      else expect(c.note.length, c.task).toBeGreaterThan(20);
    }
    for (const id of ["5.3", "6.1", "6.8", "6.9", "6.11", "7.2", "7.3", "7.8", "W4.13", "W4.31"]) expect((COVERAGE as Array<{ task: string }>).some((c) => c.task === id), id).toBe(true);
  });

  it("selects optional steps only on request, and --only / --skip", () => {
    expect(selectSteps(steps).some((s: Step) => s.id === "dictalm3")).toBe(false);
    expect(selectSteps(steps, { withOptional: ["dictalm3"] }).some((s: Step) => s.id === "dictalm3")).toBe(true);
    expect(selectSteps(steps, { only: ["fim", "pdf-chat"] }).map((s: Step) => s.id)).toEqual(["pdf-chat", "fim"]);
    expect(selectSteps(steps, { skip: ["fim"] }).some((s: Step) => s.id === "fim")).toBe(false);
  });
});

describe("availability and the checklist", () => {
  const fim = steps.find((s) => s.id === "fim")!;
  const bench = steps.find((s) => s.id === "bench-models")!;
  const meetings = steps.find((s) => s.id === "meetings")!;

  it("calls a step whose script is not on the branch unavailable, naming the PR that brings it", () => {
    expect(availability(fim, { scripts: { "bench:fim": "x" } })).toEqual({ ok: true });
    const a = availability(bench, { scripts: {} });
    expect(a.status).toBe("unavailable");
    expect(a.reason).toContain("#421");
    expect(availability(meetings, { scripts: { "eval:meetings": "x" } }).status).toBe("blocked");
    expect(availability(meetings, { scripts: { "eval:meetings": "x" }, options: { meetingsDir: "/m" } }).ok).toBe(true);
  });

  it("lists each missing model with its exact `ollama pull` tag, and flags the fake server and an old Ollama", () => {
    const sel = selectSteps(steps).map((s: Step) => ({ ...s, available: { ok: true } }));
    const env = { url: "http://127.0.0.1:11434", node: "22.12.0", nodeModules: true, ollama: { version: "0.4.7", fake: false, models: ["qwen2.5:7b"] }, gpu: "NVIDIA RTX 4070, 12282 MiB", tools: { python3: true, ffmpeg: true, chromium: true }, diskFreeGB: 100 };
    const items = checklist(sel, env) as Item[];
    const fixes = items.filter((i) => !i.ok).map((i) => i.fix);
    for (const tag of ["gemma3:12b", "qwen2.5-coder:1.5b", "qwen3:0.6b", "nomic-embed-text"]) expect(fixes).toContain(`ollama pull ${tag}`);
    expect(fixes).not.toContain("ollama pull qwen2.5:7b");
    expect(items.find((i) => i.text.startsWith("Ollama"))!.ok).toBe(false); // 0.4.7 < 0.5.0 (JSON-schema format)
    const fake = checklist(sel, { ...env, ollama: { version: "0.12.0", fake: true, models: [] } }) as Item[];
    expect(fake.find((i) => i.text.startsWith("Ollama"))!.text).toContain("FAKE");
    expect(compareVersions("0.12.0", "0.5.0")).toBe(1);
    expect(compareVersions("0.5.0", "0.5")).toBe(0);
  });
});

describe("resume and judging", () => {
  it("keeps finished steps, runs killed and interrupted ones again, and --redo", () => {
    const sel = selectSteps(steps, { only: ["agents-gemma3", "fim", "real-tiny", "pdf-chat"] });
    const state = { steps: { "agents-gemma3": { status: "pass" }, fim: { status: "running" }, "real-tiny": { status: "interrupted" } } };
    expect(pendingSteps(sel, state).map((s: Step) => s.id)).toEqual(["pdf-chat", "fim", "real-tiny"]);
    expect(pendingSteps(sel, state, ["agents-gemma3"]).map((s: Step) => s.id)).toContain("agents-gemma3");
  });

  it("fails a step on its exit code or on its target", () => {
    const g = steps.find((s) => s.id === "agents-gemma3")!;
    const f = steps.find((s) => s.id === "fim")!;
    expect(judge(g, 1, { share: 1 })).toBe("fail");
    expect(judge(g, 0, { share: 0.89 })).toBe("fail");
    expect(judge(g, 0, { share: 0.9 })).toBe("pass");
    expect(judge(f, 0, { p50Ms: 301 })).toBe("fail");
    expect(judge(f, 0, { p50Ms: 120 })).toBe("pass");
    expect(judge(f, 0, null)).toBe("pass");
  });
});

describe("metrics from the evals' own files", () => {
  it("counts agent cases per agent, ignoring skipped ones", () => {
    const dir = tmp();
    const ok = [{ ok: true }];
    writeFileSync(
      join(dir, "agents-2026-11-12-gemma3_12b.json"),
      JSON.stringify({ model: "gemma3:12b", kind: "model", results: [
        { id: "a", agent: "tagger", checks: ok },
        { id: "b", agent: "tagger", checks: [{ ok: false }] },
        { id: "c", agent: "writer", checks: ok },
        { id: "d", agent: "writer", status: "skipped", checks: [] },
        { id: "e", agent: "linker", error: "timeout", checks: [] },
      ] }),
    );
    const m = agentsMetrics(dir);
    expect(m).toMatchObject({ passed: 2, total: 4, share: 0.5, agents: 3, kind: "model" });
    expect(m.byAgent.tagger).toEqual({ passed: 1, total: 2 });
  });

  it("scores PDF chat citations with nDCG@5", () => {
    expect(ndcgAt([3], [3])).toBe(1);
    expect(ndcgAt([1, 3], [3])).toBeCloseTo(1 / Math.log2(3), 6);
    expect(ndcgAt([1, 2], [3])).toBe(0);
    expect(ndcgAt([3, 3, 4], [3, 4])).toBeCloseTo((1 + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)), 6);
    const dir = tmp();
    writeFileSync(join(dir, "pdf-chat-2026-11-12-qwen2.5_7b.json"), JSON.stringify({ passed: 1, total: 2, rows: [{ pages: [2], answerPages: [2] }, { pages: [5], answerPages: [1] }] }));
    expect(pdfChatMetrics(dir)).toEqual({ passed: 1, total: 2, share: 0.5, citationNdcg5: 0.5 });
  });
});

describe("dictation WER (plan W4.13)", () => {
  it("reads normal form v2 as the headline and keeps v1 next to it", () => {
    const dir = tmp();
    writeFileSync(join(dir, "asr-web.json"), JSON.stringify({ engine: "itayinbar/Ozen-v1", splits: { "fleurs-validation": { wer: 0.21, "wer.v2": 0.14, "latency.p95Ms": 900 } } }));
    expect(asrMetrics(join(dir, "asr-web.json"), "fleurs-validation")).toMatchObject({ wer: 0.14, werV1: 0.21, p95Ms: 900 });
    const s = steps.find((x) => x.id === "asr-web")!;
    expect(judge(s, 0, { wer: 0.14 })).toBe("pass");
    expect(judge(s, 0, { wer: 0.151 })).toBe("fail");
  });
});

describe("the receipt", () => {
  const report = () => {
    const runDir = tmp();
    mkdirSync(join(runDir, "fim"));
    writeFileSync(join(runDir, "fim", "fim.json"), '{"p50Ms":120}\n');
    return { runDir, body: { schema: 1, runId: "r1", kind: "model", steps: [{ id: "fim", plan: ["6.9"], status: "pass", artifacts: artifacts(join(runDir, "fim"), runDir) }], coverage: [] } };
  };

  it("detects a changed report and a changed result file", () => {
    const { runDir, body } = report();
    const sealed = seal(body);
    expect(verifyReport(sealed, runDir)).toEqual([]);
    expect(verifyReport({ ...sealed, kind: "wiring" }, runDir)[0]).toContain("digest mismatch");
    writeFileSync(join(runDir, "fim", "fim.json"), '{"p50Ms":90}\n');
    expect(verifyReport(sealed, runDir)).toEqual(["fim/fim.json: changed after the run"]);
  });

  it("signs with an Ed25519 key and rejects a forged signature", () => {
    const { runDir, body } = report();
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sealed = seal(body, pem);
    expect(sealed.receipt.signature.alg).toBe("ed25519");
    expect(verifyReport(sealed, runDir)).toEqual([]);
    const forged = { ...sealed, receipt: { ...sealed.receipt, signature: { ...sealed.receipt.signature, value: Buffer.alloc(64).toString("base64") } } };
    expect(verifyReport(forged, runDir)).toEqual(["the signature does not match the digest"]);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => seal(body, rsa)).toThrow(/Ed25519/);
  });

  it("labels a run against the fake server as wiring, never a score", () => {
    const { body } = report();
    expect(formatReport(seal({ ...body, kind: "wiring" }))).toContain("WIRING RUN — NOT A MODEL SCORE");
    expect(formatReport(seal(body))).not.toContain("WIRING RUN");
  });
});

describe("end to end against the fake Ollama", () => {
  let fake: ChildProcess | null = null;
  afterAll(() => {
    fake?.kill();
  });

  const freePort = () =>
    new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => done(port));
      });
    });

  it("pulls the missing model, runs the FIM step, writes a sealed wiring report and resumes", async () => {
    const port = await freePort();
    fake = spawn(process.execPath, ["--experimental-strip-types", "scripts/fake-ollama.mjs", "--port", String(port)], { stdio: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      const up = await fetch(`${url}/api/version`).then((r) => r.ok, () => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const out = tmp();
    const run = () => spawnSync(process.execPath, ["scripts/models-day.mjs", "--url", url, "--out", out, "--only", "fim", "--yes"], { encoding: "utf8", timeout: 60_000 });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("pulling qwen2.5-coder:1.5b");
    expect(first.stdout).toContain("FAKE server");
    const runId = readdirSync(out).find((f) => f !== "latest.json")!;
    const rep = JSON.parse(readFileSync(join(out, runId, "report.json"), "utf8"));
    expect(rep.kind).toBe("wiring");
    expect(rep.steps[0]).toMatchObject({ id: "fim", status: "pass", metrics: { requests: 60 } });
    expect(verifyReport(rep, join(out, runId))).toEqual([]);
    // A finished run is not resumed; an unfinished one is, keeping its steps.
    writeFileSync(join(out, "latest.json"), JSON.stringify({ runId, finished: false }));
    const again = run();
    expect(again.stdout).toContain(`Resuming run ${runId}`);
    expect(again.stdout).toContain("fim: pass in an earlier session — kept");
  }, 90_000);
});
