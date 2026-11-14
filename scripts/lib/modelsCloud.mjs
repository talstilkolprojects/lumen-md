/**
 * The models day on a free cloud GPU (plan W6.18): the pure part of
 * scripts/models-cloud.mjs — the Kaggle kernel and dataset metadata, the
 * run configuration the kernel reads, and the checks on the report it
 * sends back — so they can be tested without an account.
 *
 * Why Kaggle (decided 12.11 after comparing the four free options; the
 * docs page lists the sources): it is the only one of them with an official
 * headless API (`kaggle kernels push / status / output`) that may run a
 * background server (Ollama) on a real GPU for hours: 2× T4 (16 GB each) or
 * a P100, 12 hours per session, about 30 GPU hours a week, internet on
 * request, all after a one-time phone verification. Colab's free tier has
 * no headless API and its FAQ disallows bypassing the notebook UI; Lightning
 * AI's free credits are promotional and change without notice; Hugging Face
 * ZeroGPU gives a free account 5 GPU minutes a day, Gradio only, 60 s per
 * call by default.
 */
import { generateKeyPairSync } from "node:crypto";
import { verifyReport } from "./modelsDay.mjs";

/**
 * Steps that need WebGPU in a real browser stay on Tal's Mac (plan W6.18
 * step 4). asr-web is not one of them (plan W6.19): it runs the app's ONNX
 * files on onnxruntime-node (CPU), so its WER is the model's anywhere; only
 * the WebGPU latency is bench-models'.
 */
export const MAC_ONLY_STEPS = ["bench-models"];

/**
 * Desktop dictation in the cloud (plan W1.17, W6.19): the kernel builds
 * whisper.cpp at a release tag (CUDA on the T4, else CPU) and fetches the
 * ivrit.ai turbo ggml file. The file is not pinned in the app yet
 * (WHISPER_GGML), so the kernel records the repository, revision, size,
 * sha256 and licence it measured; `npm run whisper:desktop -- pin` takes
 * exactly those values.
 */
export const WHISPER_BUILD = {
  repo: "https://github.com/ggml-org/whisper.cpp",
  tag: "v1.7.6",
  ggmlRepos: ["ivrit-ai/whisper-large-v3-turbo-ggml"],
  ggmlSearch: { author: "ivrit-ai", search: "ggml" },
  preferFile: "ggml-model.bin",
};

/** The plan's dictation targets per path (W4.13, W6.19): phone and browser ≤ 15 %, desktop ≤ 10 %. */
export const DICTATION_PATHS = [
  { path: "phone (Zipformer2 streaming)", step: "asr-zipformer", engine: "zipformer", target: 0.15 },
  { path: "browser (ivrit.ai turbo ONNX)", step: "asr-web", engine: "whisper-web", target: 0.15 },
  { path: "desktop (whisper.cpp, ivrit.ai turbo ggml)", step: "asr-whisper-cpp", engine: "whisper-cpp", target: 0.1 },
];

/** The accelerator: Kaggle's default GPU, 2× T4 with 16 GB each (gemma3:12b fits on one). */
export const ACCELERATOR = "NvidiaTeslaT4";

/** The pinned Node for the kernel (the repo's engines: ≥ 22.6). */
export const NODE_VERSION = "22.12.0";

/** Kaggle slugs: lowercase letters, digits and dashes, 5–50 characters. */
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

export const kernelId = (user) => `${user}/lumen-models-day`;
export const datasetId = (user, runId) => `${user}/${slug(`lumen-run-${runId}`)}`;

/** kernel-metadata.json (Kaggle CLI docs/kernels_metadata.md): private, GPU, internet, the run's dataset attached. */
export function kernelMetadata(user, runId) {
  return {
    id: kernelId(user),
    title: "lumen-models-day",
    code_file: "run.py",
    language: "python",
    kernel_type: "script",
    is_private: true,
    enable_gpu: true,
    enable_internet: true,
    machine_shape: ACCELERATOR,
    dataset_sources: [datasetId(user, runId)],
    competition_sources: [],
    kernel_sources: [],
    model_sources: [],
  };
}

/** dataset-metadata.json: the run's inputs, private (Kaggle datasets are private unless --public). */
export function datasetMetadata(user, runId) {
  return { title: slug(`lumen-run-${runId}`), id: datasetId(user, runId), licenses: [{ name: "other" }], isPrivate: true };
}

/**
 * A one-run Ed25519 key: the kernel signs the report with the private half,
 * the runner keeps the public half and accepts only a report signed by it.
 * That ties the report to the job this runner started.
 */
export function runSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

/** The models:day arguments the kernel runs: everything but the WebGPU steps, DictaLM opted in. */
export function dayArgs({ runId, url, out, signKey, only = [], skip = [], withOptional = ["dictalm3"], whisperGgml = "{whisperGgml}", whisperCli = "{whisperCli}" }) {
  const sk = [...new Set([...MAC_ONLY_STEPS, ...skip])].filter((s) => !only.includes(s));
  return ["scripts/models-day.mjs", "--url", url, "--out", out, "--run", runId, "--yes", "--sign-key", signKey, "--whisper-ggml", whisperGgml, "--whisper-cli", whisperCli, ...(only.length ? ["--only", only.join(",")] : []), ...(sk.length && !only.length ? ["--skip", sk.join(",")] : []), ...(withOptional.length && !only.length ? ["--with", withOptional.join(",")] : [])];
}

/**
 * The kernel's placeholders filled in. A value the kernel does not have
 * (whisper.cpp did not build, no ggml file) drops its flag, so the step is
 * reported blocked rather than run against a missing file.
 */
export function fillDayArgs(args, values) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^\{(\w+)\}$/.exec(args[i + 1] ?? "");
    if (args[i].startsWith("--") && m && !(m[1] in values && values[m[1]])) {
      i++;
      continue;
    }
    out.push(args[i].replace(/\{(\w+)\}/g, (all, k) => values[k] ?? all));
  }
  return out;
}

/**
 * What the kernel reads (run.json in the run's private dataset). It holds
 * the one-run secrets (the signing key, the held-out run copy's key) and
 * never the evaluator's own key.
 */
export function runConfig({ runId, repo, commit, requester, signing, heldout = null, only = [], skip = [], withOptional = ["dictalm3"] }) {
  // {url}, {out} and {signKey} are filled in by the kernel.
  const args = dayArgs({ runId, url: "{url}", out: "{out}", signKey: "{signKey}", only, skip, withOptional });
  return { schema: 1, plan: "W6.18", runId, repo, commit, requester, signKeyPem: signing.privatePem, heldout, dayArgs: args, macOnly: MAC_ONLY_STEPS, node: NODE_VERSION, whisper: WHISPER_BUILD };
}

/**
 * Problems of a report the cloud sent back (empty = accept): the receipt
 * and every file (models:day verify), a signature by this run's key, the
 * commit that was asked for, real models on a real GPU.
 */
export function checkCloudReport(report, base, expected, { allowWiring = false } = {}) {
  const problems = verifyReport(report, base);
  const sig = report.receipt?.signature;
  if (!sig) problems.push("the report is not signed (the kernel signs it with this run's key)");
  else if (sig.publicKey.trim() !== expected.publicPem.trim()) problems.push("the report is signed by another key than this run's: it is not the job this runner started");
  if (report.git?.commit !== expected.commit) problems.push(`the report is for commit ${report.git?.commit ?? "?"}, the run asked for ${expected.commit}`);
  if (report.runId !== expected.runId) problems.push(`the report is run ${report.runId}, expected ${expected.runId}`);
  if (report.kind !== "model" && !allowWiring) problems.push("a wiring run (fake Ollama), not a model score");
  if (report.kind === "model" && !report.host?.gpu) problems.push("no GPU was found on the cloud machine");
  return problems;
}

/** The W6.18 acceptance, read off the report: ≥ 4 models with a digest, the tool-call share, the steps that ran. */
export function acceptance(report) {
  const digests = Object.entries(report.models ?? {}).filter(([, d]) => !!d);
  const steps = report.steps ?? [];
  const tc = steps.find((s) => s.id === "tool-calls")?.metrics?.share ?? steps.find((s) => s.id === "heldout")?.metrics?.share ?? null;
  const real = (report.coverage ?? []).filter((c) => c.step && ["pass", "fail"].includes(steps.find((s) => s.id === c.step)?.status));
  return {
    modelsWithDigest: digests.length,
    fourModels: digests.length >= 4,
    toolCallShare: tc,
    toolCallTarget: tc === null ? "not measured" : tc >= 0.95 ? "met (≥ 95 %)" : `missed: ${(tc * 100).toFixed(1)} % < 95 % (the gap is recorded as is)`,
    tasksMeasured: real.map((c) => c.task),
    tenTasks: real.length >= 10 && report.kind === "model",
    pass: steps.filter((s) => s.status === "pass").length,
    fail: steps.filter((s) => s.status === "fail").length,
  };
}

/**
 * Plan W6.19's honest report: for each dictation path, its WER on FLEURS-he
 * validation and on the held-out asr-he set, against its target, and the
 * verdict — met, missed (with the number), or not measured (with why).
 * `desktopFallback` says whether "send to my desktop" is the phone's way to
 * the target: the phone misses it and the desktop meets the phone's.
 */
export function dictationVerdict(report) {
  const steps = report.steps ?? [];
  const asrHe = steps.find((s) => s.id === "heldout")?.metrics?.sets?.["asr-he"] ?? null;
  const rows = DICTATION_PATHS.map((p) => {
    const st = steps.find((s) => s.id === p.step);
    const fleurs = typeof st?.metrics?.wer === "number" ? st.metrics.wer : null;
    const h = asrHe?.engines?.[p.engine];
    const heldout = h && typeof h === "object" && typeof h.wer === "number" ? h.wer : null;
    const headline = heldout ?? fleurs;
    const why = headline === null ? (typeof h === "string" ? `held-out: ${h}` : st ? `${p.step}: ${st.status}${st.reason ? ` (${st.reason})` : ""}` : `${p.step} did not run`) : null;
    const pct = (x) => `${(x * 100).toFixed(1)} %`;
    return {
      ...p,
      fleurs,
      heldout,
      verdict: headline === null ? `not measured — ${why}` : headline <= p.target ? `met: ${pct(headline)} ≤ ${pct(p.target)}` : `missed: ${pct(headline)} > ${pct(p.target)}`,
      met: headline === null ? null : headline <= p.target,
    };
  });
  const phone = rows[0];
  const desktop = rows[2];
  const desktopWer = desktop.heldout ?? desktop.fleurs;
  return { rows, desktopFallback: phone.met === false && desktopWer !== null && desktopWer <= phone.target, kind: report.kind ?? null };
}

/** Kaggle's kernel status line → one of queued, running, complete, error, cancelled, unknown. */
export function parseStatus(text) {
  const t = String(text ?? "").toLowerCase();
  for (const s of ["complete", "error", "cancel", "running", "queued"]) if (t.includes(s)) return s === "cancel" ? "cancelled" : s;
  return "unknown";
}
