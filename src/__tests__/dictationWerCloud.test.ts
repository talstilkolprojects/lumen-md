// @vitest-environment node
/**
 * Plan W6.19 — a real Hebrew dictation WER from `npm run models:cloud`: the
 * held-out asr-he set and FLEURS-he validation through each dictation path
 * (phone: Zipformer streaming; browser: ivrit.ai turbo ONNX as the app runs
 * it; desktop: whisper.cpp with the turbo ggml), each against its target,
 * and the honest verdict the runner prints. The engines are fakes here with
 * set scores (the real ones need the model downloads); the plumbing, the
 * arguments and the verdict are the real code.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { DICTATION_PATHS, MAC_ONLY_STEPS, WHISPER_BUILD, dayArgs, dictationVerdict, fillDayArgs, runConfig, runSigningKey } from "../../scripts/lib/modelsCloud.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { COVERAGE, STEPS, availability, heldoutMetrics } from "../../scripts/lib/modelsDay.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { ASR_ENGINES, scoreAsr } from "../../scripts/heldout/score.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "w619-"));

type Cmd = { cmd: string; args: string[] };
type Step = { id: string; target?: { max: number }; blockedUnless?: { option: string }; requires: { file?: string; script?: string }; commands: (c: Record<string, unknown>) => Cmd[] };
const step = (id: string) => (STEPS as Step[]).find((s) => s.id === id)!;

/** A fake engine script: writes `split` with `wer` to the file after --out (what the real three write), prints nothing. */
function fakeEngine(dir: string, name: string, split: string, wer: number, extra: Record<string, unknown> = {}): string {
  const f = join(dir, `${name}.mjs`);
  writeFileSync(
    f,
    `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
writeFileSync(a[a.indexOf("--out") + 1], JSON.stringify({ splits: { ${JSON.stringify(split)}: { wer: ${wer}, cer: ${wer / 3}, items: 3, ...${JSON.stringify(extra)} } }, args: a }));`,
  );
  return f;
}

describe("W6.19 the cloud run measures every dictation path", () => {
  it("asr-web runs in the cloud (its WER is the model's, on CPU); only bench-models stays on the Mac", () => {
    expect(MAC_ONLY_STEPS).not.toContain("asr-web");
    expect(MAC_ONLY_STEPS).toContain("bench-models");
    const web = step("asr-web").commands({ cache: "/c", dir: "/d", url: "u" });
    // Ozen v1 is not measured while it is off (licence of its training data unapproved).
    expect(web.at(-1)!.args).toEqual(["run", "eval:asr-web", "--", "--fleurs", "/c/fleurs-validation", "--models", "turbo", "--out", "/d/asr-web.json"]);
    expect(web[0].args).toContain("scripts/asr/fleurs_spike.py");
  });

  it("the desktop step is blocked without the ggml file, runs whisper.cpp on FLEURS with it, and is held to 10 %", () => {
    const s = step("asr-whisper-cpp");
    expect(s.target!.max).toBe(0.1);
    const root = tmp();
    writeFileSync(join(root, "x"), "");
    const scripts = {};
    expect(availability({ ...s, requires: { file: "x" } }, { scripts, root, options: {} })).toMatchObject({ ok: false, status: "blocked" });
    expect(availability({ ...s, requires: { file: "x" } }, { scripts, root, options: { whisperGgml: "/m.bin" } })).toEqual({ ok: true });
    const cmds = s.commands({ cache: "/c", dir: "/d", whisperGgml: "/m.bin", whisperCli: "/w/whisper-cli" });
    expect(cmds.at(-1)).toMatchObject({ cmd: "node", args: ["scripts/whisper-desktop.mjs", "wer", "--split", "fleurs-validation=/c/fleurs-validation", "--model", "/m.bin", "--cli", "/w/whisper-cli", "--out", "/d/whisper-cpp.json"] });
    expect(COVERAGE.find((c: { task: string }) => c.task === "W1.17").step).toBe("asr-whisper-cpp");
    expect(COVERAGE.find((c: { task: string }) => c.task === "W6.19").step).toBe("heldout");
  });

  it("the held-out step scores asr-he through all three paths, with the desktop's file when the kernel has it", () => {
    const h = step("heldout");
    const run = (c: Record<string, unknown>) => h.commands({ cache: "/c", dir: "/d", url: "u", ...c }).at(-1)!.args;
    const plain = run({});
    expect(plain[plain.indexOf("--asr-engines") + 1]).toBe("zipformer,whisper-web,whisper-cpp");
    expect(run({})).not.toContain("--whisper-ggml");
    const w = run({ whisperGgml: "/m.bin", whisperCli: "/w/cli" });
    expect(w.slice(w.indexOf("--whisper-ggml"), w.indexOf("--whisper-ggml") + 4)).toEqual(["--whisper-ggml", "/m.bin", "--whisper-cli", "/w/cli"]);
  });

  it("the kernel fills its placeholders, and drops a flag it has no value for (JS and the kernel's Python agree)", () => {
    const args = dayArgs({ runId: "r", url: "{url}", out: "{out}", signKey: "{signKey}" });
    const cases = [
      { url: "U", out: "O", signKey: "S", whisperGgml: "/g.bin", whisperCli: "/w" },
      { url: "U", out: "O", signKey: "S" },
      { url: "U", out: "O", signKey: "S", whisperCli: "/w" },
    ];
    for (const v of cases) {
      const js = fillDayArgs(args, v) as string[];
      expect(js.some((a) => /\{\w+\}/.test(a))).toBe(false);
      const py = spawnSync("python3", ["-I", "-B", "-c", "import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('k',sys.argv[1]);k=importlib.util.module_from_spec(s);s.loader.exec_module(k)\nprint(json.dumps(k.fill_day_args(json.loads(sys.argv[2]),json.loads(sys.argv[3]))))", "scripts/cloud/kaggle_kernel.py", JSON.stringify(args), JSON.stringify(v)], { encoding: "utf8" });
      expect(py.status, py.stderr).toBe(0);
      expect(JSON.parse(py.stdout)).toEqual(js);
    }
    expect(fillDayArgs(args, cases[1])).not.toContain("--whisper-ggml");
    // The kernel builds a pinned whisper.cpp release and looks for the ivrit.ai turbo ggml.
    expect(WHISPER_BUILD.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(runConfig({ runId: "r", repo: "o/r", commit: "c", requester: "t", signing: runSigningKey() }).whisper).toEqual(WHISPER_BUILD);
  });
});

describe("W6.19 asr-he: one set of clips, three engines, numbers only", () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("scores each path against its own target and keeps the Zipformer's numbers where older readers look", () => {
    const dir = tmp();
    const clips = tmp();
    const model = tmp();
    writeFileSync(join(model, "tokens.txt"), "");
    writeFileSync(join(dir, "m.bin"), "");
    const scripts = {
      zipformer: fakeEngine(dir, "zip", "heldout", 0.236),
      "whisper-web": fakeEngine(dir, "web", "fleurs-validation", 0.118, { "wer.v2": 0.11 }),
      "whisper-cpp": fakeEngine(dir, "cpp", "heldout", 0.083, { rtf: 0.06 }),
    };
    const r = scoreAsr(items, { revision: "rev", canary: "c", asrModel: model, whisperGgml: join(dir, "m.bin"), whisperCli: "/w", engines: Object.keys(ASR_ENGINES), scripts, clipsDir: clips });
    expect(r).toMatchObject({ n: 3, wer: 0.236 });
    expect(r.engines.zipformer).toMatchObject({ wer: 0.236, target: 0.15, met: false });
    expect(r.engines["whisper-web"]).toMatchObject({ wer: 0.118, werV2: 0.11, target: 0.15, met: true });
    expect(r.engines["whisper-cpp"]).toMatchObject({ wer: 0.083, rtf: 0.06, target: 0.1, met: true });
    // The engines were given the clips' folder, the turbo model only, and the desktop's file and CLI.
    const args = (f: string) => JSON.parse(readFileSync(join(clips, `scores-${f}.json`), "utf8")).args as string[];
    expect(args("whisper-web")).toEqual(["--fleurs", clips, "--models", "turbo", "--out", join(clips, "scores-whisper-web.json")]);
    expect(args("whisper-cpp").slice(0, 7)).toEqual(["wer", "--split", `heldout=${clips}`, "--model", join(dir, "m.bin"), "--cli", "/w"]);
  });

  it("says why a path is not measured, and fetches no clip when none can run", () => {
    const any = join(tmp(), "engine.mjs");
    writeFileSync(any, "");
    const t0 = Date.now();
    const r = scoreAsr(items, { revision: "rev", canary: "c", engines: ["zipformer", "whisper-cpp"], scripts: { zipformer: any, "whisper-cpp": any } });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.status).toBe("unavailable");
    expect(r.engines.zipformer.reason).toMatch(/--asr-model/);
    expect(r.engines["whisper-cpp"].reason).toMatch(/--whisper-ggml/);
  });

  it("models:day reads the three engines out of the evaluator's aggregates", () => {
    const dir = tmp();
    writeFileSync(join(dir, "heldout-2026-11-12T22-00.json"), JSON.stringify({ kind: "model", sets: { "asr-he": { version: 1, locked: true, n: 120, engine: { wer: 0.24, cer: 0.08 }, engines: { zipformer: { wer: 0.24, cer: 0.08, target: 0.15, met: false }, "whisper-web": { status: "unavailable", reason: "x" }, "whisper-cpp": { wer: 0.09, cer: 0.03, target: 0.1, met: true } } } } }));
    const m = heldoutMetrics(dir);
    expect(m.sets["asr-he"].engines).toEqual({ zipformer: { wer: 0.24, cer: 0.08, target: 0.15, met: false }, "whisper-web": "unavailable", "whisper-cpp": { wer: 0.09, cer: 0.03, target: 0.1, met: true } });
  });
});

describe("W6.19 the honest report: which path reaches its target, on which device", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    kind: "model",
    steps: [
      { id: "asr-zipformer", status: "fail", metrics: { wer: 0.236 } },
      { id: "asr-web", status: "pass", metrics: { wer: 0.131 } },
      { id: "asr-whisper-cpp", status: "blocked", reason: "needs --whisper-ggml" },
      { id: "heldout", status: "pass", metrics: { sets: { "asr-he": { engines: { zipformer: { wer: 0.251 }, "whisper-web": { wer: 0.142 }, "whisper-cpp": "unavailable" } } } } },
    ],
    ...over,
  });

  it("puts the held-out number first, FLEURS beside it, and says what was not measured and why", () => {
    const v = dictationVerdict(report());
    expect(v.rows.map((r: { engine: string }) => r.engine)).toEqual(DICTATION_PATHS.map((p: { engine: string }) => p.engine));
    expect(v.rows[0]).toMatchObject({ fleurs: 0.236, heldout: 0.251, met: false, verdict: "missed: 25.1 % > 15.0 %" });
    expect(v.rows[1]).toMatchObject({ fleurs: 0.131, heldout: 0.142, met: true, verdict: "met: 14.2 % ≤ 15.0 %" });
    expect(v.rows[2]).toMatchObject({ fleurs: null, heldout: null, met: null });
    expect(v.rows[2].verdict).toBe("not measured — held-out: unavailable");
    // Without a desktop measurement the fallback is not claimed.
    expect(v.desktopFallback).toBe(false);
  });

  it("names 'send to my desktop' as the phone's way to the target only when the desktop measured under it", () => {
    const steps = report().steps.map((s) => (s.id === "asr-whisper-cpp" ? { id: s.id, status: "pass", metrics: { wer: 0.081 } } : s.id === "heldout" ? { ...s, metrics: { sets: { "asr-he": { engines: { zipformer: { wer: 0.251 }, "whisper-cpp": { wer: 0.094 } } } } } } : s));
    const v = dictationVerdict(report({ steps }));
    expect(v.rows[2]).toMatchObject({ heldout: 0.094, fleurs: 0.081, met: true });
    expect(v.desktopFallback).toBe(true);
  });
});
