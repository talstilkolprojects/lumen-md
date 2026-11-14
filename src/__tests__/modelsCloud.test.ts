// @vitest-environment node
/**
 * Plan W6.18 — the models day on a free Kaggle GPU (scripts/models-cloud.mjs):
 * the kernel and dataset metadata, the run configuration (one-run secrets,
 * never the evaluator's key), the checks on the report that comes back, the
 * held-out run copy, and the whole round trip against a fake `kaggle` CLI
 * that runs the real kernel script (scripts/cloud/kaggle_kernel.py) in
 * emulation mode against the fake Ollama: push, wait, fetch, verify.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACCELERATOR,
  MAC_ONLY_STEPS,
  acceptance,
  checkCloudReport,
  datasetMetadata,
  dayArgs,
  kernelMetadata,
  parseStatus,
  runConfig,
  runSigningKey,
  slug,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/lib/modelsCloud.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { seal } from "../../scripts/lib/modelsDay.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { decrypt, generateKey } from "../../scripts/lib/heldout.mjs";

const ROOT = resolve(".");
const tmp = () => mkdtempSync(join(tmpdir(), "models-cloud-"));

describe("the Kaggle job", () => {
  it("is a private script kernel on a GPU with internet, reading the run's private dataset", () => {
    const k = kernelMetadata("tal", "cloud-2026-11-12-21-00");
    expect(k).toMatchObject({ id: "tal/lumen-models-day", code_file: "run.py", language: "python", kernel_type: "script", is_private: true, enable_gpu: true, enable_internet: true, machine_shape: ACCELERATOR });
    expect(k.dataset_sources).toEqual(["tal/lumen-run-cloud-2026-11-12-21-00"]);
    expect(datasetMetadata("tal", "x")).toMatchObject({ isPrivate: true, id: "tal/lumen-run-x" });
    expect(slug("Lumen Run: 12.11/A")).toBe("lumen-run-12-11-a");
  });

  it("runs models:day without the WebGPU steps, with DictaLM, signed by the run's key", () => {
    const args = dayArgs({ runId: "r", url: "{url}", out: "{out}", signKey: "{signKey}" });
    // The desktop Whisper's file and CLI are the kernel's to fill (plan W6.19); asr-web runs in the cloud, bench-models does not.
    expect(args).toEqual(["scripts/models-day.mjs", "--url", "{url}", "--out", "{out}", "--run", "r", "--yes", "--sign-key", "{signKey}", "--whisper-ggml", "{whisperGgml}", "--whisper-cli", "{whisperCli}", "--skip", MAC_ONLY_STEPS.join(","), "--with", "dictalm3,asr-whisper-cpp"]);
    expect(MAC_ONLY_STEPS).toEqual(["bench-models"]);
    expect(dayArgs({ runId: "r", url: "u", out: "o", signKey: "k", only: ["fim"] })).not.toContain("--skip");
  });

  it("carries one-run secrets only, never the evaluator's key", () => {
    const signing = runSigningKey();
    const master = generateKey();
    const runKey = generateKey();
    const cfg = runConfig({ runId: "r", repo: "talstilkol/lumen-md", commit: "abc", requester: "t", signing, heldout: { key: runKey.secret, file: "heldout.lho" } });
    const text = JSON.stringify(cfg);
    expect(text).not.toContain(master.secret);
    expect(text).not.toContain(signing.publicPem.trim().split("\n")[1]);
    expect(cfg.signKeyPem).toContain("PRIVATE KEY");
    expect(cfg.node).toMatch(/^22\./);
  });

  it("reads Kaggle's status lines", () => {
    expect(parseStatus('tal/lumen-models-day has status "KernelWorkerStatus.COMPLETE"')).toBe("complete");
    expect(parseStatus("running")).toBe("running");
    expect(parseStatus('has status "KernelWorkerStatus.ERROR"')).toBe("error");
    expect(parseStatus("")).toBe("unknown");
  });
});

describe("the report that comes back", () => {
  const base = tmp();
  const signing = runSigningKey();
  const expected = { runId: "r1", commit: "c0ffee", publicPem: signing.publicPem };
  const body = { schema: 1, runId: "r1", kind: "model", git: { commit: "c0ffee" }, host: { gpu: "Tesla T4, 15360 MiB" }, models: { "qwen2.5:7b": "sha256:a", "gemma3:12b": "sha256:b", "qwen2.5-coder:1.5b": "sha256:c", "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF": "sha256:d" }, steps: [{ id: "tool-calls", status: "pass", artifacts: [], metrics: { share: 0.93 } }], coverage: [{ task: "W4.31", step: "tool-calls" }] };

  it("is accepted only when sealed by this run's key, for the asked commit, on a GPU", () => {
    expect(checkCloudReport(seal(body, signing.privatePem), base, expected)).toEqual([]);
    expect(checkCloudReport(seal(body), base, expected)[0]).toMatch(/not signed/);
    expect(checkCloudReport(seal(body, runSigningKey().privatePem), base, expected)[0]).toMatch(/another key/);
    expect(checkCloudReport(seal({ ...body, git: { commit: "bad" } }, signing.privatePem), base, expected)[0]).toMatch(/asked for c0ffee/);
    expect(checkCloudReport(seal({ ...body, kind: "wiring" }, signing.privatePem), base, expected)[0]).toMatch(/wiring/);
    expect(checkCloudReport(seal({ ...body, host: {} }, signing.privatePem), base, expected)[0]).toMatch(/no GPU/);
    const edited = { ...seal(body, signing.privatePem), kind: "model", runId: "r1", models: {} };
    expect(checkCloudReport(edited, base, expected)[0]).toMatch(/digest mismatch/);
  });

  it("states the W6.18 acceptance as measured, including a missed target", () => {
    const a = acceptance(body);
    expect(a).toMatchObject({ modelsWithDigest: 4, fourModels: true, toolCallShare: 0.93, tasksMeasured: ["W4.31"], tenTasks: false });
    expect(a.toolCallTarget).toMatch(/missed: 93.0 %/);
  });
});

describe("round trip against a fake Kaggle", () => {
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

  /** A `kaggle` CLI stand-in: datasets go to a folder, `kernels push` runs the kernel script in emulation. */
  function fakeKaggle(dir: string) {
    const bin = join(dir, "kaggle");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const S = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
appendFileSync(join(S, "calls.log"), a.join(" ") + "\\n");
const p = a.includes("-p") ? a[a.indexOf("-p") + 1] : null;
if (a[0] === "--version") console.log("Kaggle API 1.7.4.5");
else if (a[0] === "datasets" && a[1] === "create") {
  const id = JSON.parse(readFileSync(join(p, "dataset-metadata.json"), "utf8")).id;
  cpSync(p, join(S, "input", id.split("/")[1]), { recursive: true });
} else if (a[0] === "datasets" && a[1] === "status") console.log("ready");
else if (a[0] === "kernels" && a[1] === "push") {
  const meta = JSON.parse(readFileSync(join(p, "kernel-metadata.json"), "utf8"));
  if (!meta.enable_gpu || !meta.is_private) { console.error("refused"); process.exit(1); }
  const r = spawnSync("python3", ["-I", join(p, meta.code_file)], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env: { ...process.env, LUMEN_CLOUD_EMULATE: "1", KAGGLE_INPUT: join(S, "input"), KAGGLE_WORKING: join(S, "working"), LUMEN_CLOUD_TMP: join(S, "tmp") } });
  writeFileSync(join(S, "status"), r.status === 0 ? "complete" : "error");
  writeFileSync(join(S, "kernel-stderr.txt"), r.stderr || "");
  console.log("Kernel version 1 successfully pushed.");
} else if (a[0] === "kernels" && a[1] === "status") console.log(a[2] + ' has status "KernelWorkerStatus.' + (existsSync(join(S, "status")) ? readFileSync(join(S, "status"), "utf8").toUpperCase() : "RUNNING") + '"');
else if (a[0] === "kernels" && a[1] === "output") cpSync(join(S, "working"), p, { recursive: true });
else if (a[0] === "kernels" && a[1] === "list") console.log("ok");
else { console.error("fake kaggle: unknown " + a.join(" ")); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("pushes the run, the kernel runs models:day with the held-out copy, and the signed report comes back verified", async () => {
    const root = tmp();
    const kdir = join(root, "kaggle");
    mkdirSync(kdir);
    const bin = fakeKaggle(kdir);
    const port = await freePort();
    fake = spawn(process.execPath, ["--experimental-strip-types", "scripts/fake-ollama.mjs", "--port", String(port)], { stdio: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${url}/api/version`).then((r) => r.ok, () => false)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    // A held-out store built from a tiny synthetic pool, as the evaluator host has one (plan W6.17).
    const master = generateKey();
    const store = join(root, "store");
    const rows = join(root, "rows");
    mkdirSync(rows);
    const words = "אבן גשר דלת הר ורד זית חלון טל ים כוכב לחם מים נהר סלע עץ פרח".split(" ");
    const w = (i: number, n: number) => Array.from({ length: n }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(" ");
    const j = (sp: number, gr: number) => [0, 1, 2].map(() => ({ spelling_score: sp, grammar_score: gr }));
    const pools: Record<string, unknown[]> = {
      mkqa: Array.from({ length: 450 }, (_, i) => ({ id: String(i), he_query: `${w(i, 5)} ${i}?`, answers_he: [{ type: "entity", text: words[i % words.length], aliases: [] }], answers_en: [] })),
      fleurs: Array.from({ length: 220 }, (_, i) => ({ id: `fleurs-train-${i}`, text: w(i, 12), durationMs: 4000, file: `${i}.wav` })),
      "massive-validation": Array.from({ length: 400 }, (_, i) => ({ id: `v${i}`, intent: "alarm_set", utt: `${w(i, 4)} ${i}`, annot_utt: "[time : שבע]", judgments: i % 2 ? j(2, 4) : j(0, 1) })),
      "massive-test": Array.from({ length: 320 }, (_, i) => ({ id: `t${i}`, intent: i % 2 ? "alarm_set" : "weather_query", utt: `${w(i, 4)} ${i}`, annot_utt: "[date : מחר]", judgments: [] })),
      "global-mmlu": Array.from({ length: 220 }, (_, i) => ({ id: `s${i}`, he: { question: `${w(i, 8)} ${i}?`, options: ["א", "ב", "ג", "ד"] }, en: { question: `q ${i}?`, options: ["a", "b", "c", "d"] }, answer: "A" })),
    };
    for (const [name, list] of Object.entries(pools)) writeFileSync(join(rows, `${name}.jsonl`), [JSON.stringify({ meta: { source: name, revision: "r", files: {}, license: "test" } }), ...list.map((x) => JSON.stringify(x))].join("\n") + "\n");
    const env = { ...process.env, HOME: root, LUMEN_HELDOUT_KEY: master.secret, LUMEN_HELDOUT_DIR: store, LUMEN_HELDOUT_REQUESTER: "test@host", LUMEN_KAGGLE_CLI: bin, LUMEN_CLOUD_DIR: join(root, "state"), LUMEN_CLOUD_REPO: ROOT, LUMEN_CLOUD_OLLAMA_URL: url };
    const build = spawnSync(process.execPath, ["scripts/heldout.mjs", "build", "--from-rows", rows], { encoding: "utf8", env });
    expect(build.status, build.stderr).toBe(0);

    const results = join(root, "results");
    const run = spawnSync(process.execPath, ["scripts/models-cloud.mjs", "run", "--user", "tester", "--run", "cloud-test", "--only", "fim,heldout", "--force", "--allow-wiring", "--poll-seconds", "1", "--results", results], { encoding: "utf8", env, timeout: 400_000 });
    const kerr = existsSync(join(kdir, "kernel-stderr.txt")) ? readFileSync(join(kdir, "kernel-stderr.txt"), "utf8") : "";
    expect(run.status, run.stdout + run.stderr + kerr).toBe(0);
    expect(run.stdout).toContain("Run copy of 6 sets");
    expect(run.stdout).toContain("signed by this run's key");
    expect(run.stdout).toContain("WIRING run");
    const calls = readFileSync(join(kdir, "calls.log"), "utf8");
    expect(calls).toMatch(/^datasets create -p .* --dir-mode zip -q$/m);
    expect(calls).toMatch(/^kernels push -p /m);
    expect(calls).toMatch(/^kernels output tester\/lumen-models-day -p /m);

    // The dataset holds the run copy and the run's own keys, never the evaluator's key.
    const ds = join(kdir, "input", "lumen-run-cloud-test");
    const cfg = JSON.parse(readFileSync(join(ds, "run.json"), "utf8"));
    expect(readFileSync(join(ds, "run.json"), "utf8")).not.toContain(master.secret);
    const copy = decrypt(readFileSync(join(ds, "heldout.lho")), cfg.heldout.key) as { sets: Record<string, unknown>; from: string };
    expect(Object.keys(copy.sets).sort()).toEqual(["asr-he", "grammar-he", "ocr-he", "qa-he", "toolcall-he", "xling"]);
    expect(() => decrypt(readFileSync(join(ds, "heldout.lho")), master.secret)).toThrow(/another key/);
    // A run copy can score, never build (it has no split secret) or export.
    const copyEnv = { ...env, LUMEN_HELDOUT_KEY: cfg.heldout.key, LUMEN_HELDOUT_EXPORT: join(ds, "heldout.lho"), LUMEN_HELDOUT_DIR: join(root, "copy-store") };
    const refused = spawnSync(process.execPath, ["scripts/heldout.mjs", "build", "--from-rows", rows], { encoding: "utf8", env: copyEnv });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("a run copy can only score");
    // The local copy of the secrets is gone once they are on Kaggle.
    expect(existsSync(join(root, "state", "cloud-test", "dataset"))).toBe(false);

    // What came back: the sealed report, with the fim step and the held-out step scored in the "cloud".
    const out = join(results, "cloud-test");
    const rep = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(rep.receipt.signature.alg).toBe("ed25519");
    expect(rep.steps.find((s: { id: string }) => s.id === "fim").status).toBe("pass");
    const h = rep.steps.find((s: { id: string }) => s.id === "heldout");
    expect(h.status, JSON.stringify(h)).toBe("pass");
    expect(h.metrics.scan.verdict).toBe("clean");
    expect(h.metrics.log.requester).toBe("test@host via kaggle");
    expect(Object.keys(h.metrics.sets).length).toBe(6);
    expect(JSON.parse(readFileSync(join(out, "cloud.json"), "utf8"))).toMatchObject({ phase: "done", runId: "cloud-test" });
    // No held-out item in anything that came back.
    const back = readdirSync(out, { recursive: true, encoding: "utf8" }).filter((f) => !f.endsWith("/")).map((f) => { try { return readFileSync(join(out, f), "utf8"); } catch { return ""; } }).join("\n");
    for (const x of pools.mkqa.slice(0, 40) as Array<{ he_query: string }>) expect(back.includes(x.he_query)).toBe(false);
    // The evaluator logged the export, with who asked.
    const exportEntry = readFileSync(join(store, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.action === "export");
    expect(exportEntry.requester).toBe("test@host → kaggle cloud-test");
  }, 600_000);

  it("refuses a run without an account and names the owner step", () => {
    const r = spawnSync(process.execPath, ["scripts/models-cloud.mjs", "run", "--no-heldout"], { encoding: "utf8", env: { ...process.env, HOME: tmp(), KAGGLE_USERNAME: "", LUMEN_CLOUD_DIR: tmp() } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Phone verification");
  });
});
