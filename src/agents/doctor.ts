/**
 * AI doctor (MASTER_PLAN v3, T21): one deterministic diagnosis of the
 * local-AI stack, in the order a user would debug it by hand — the AI
 * policy, the Ollama server (reachable? CORS? version? models? tools?),
 * the GPU for the in-browser model, the storage the vault lives in, the
 * service worker, the CSP, the local services (grammar, research) — and,
 * on request, one golden case per agent through the real runtime.
 *
 * Every finding carries the exact fix: a shell command to copy, or an
 * action the panel runs in one click. Nothing here guesses; a check that
 * cannot run says "skipped" and why.
 */

import type { ExecutorId } from "./types";
import "./doctorLazyStrings";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorFix {
  /** Short imperative label. */
  label: string;
  /** Shell command to copy, when the fix happens outside the browser. */
  command?: string;
  /** In-app action the panel can run. */
  action?: "persist" | "openSettings" | "pullModel" | "setPolicyLocalFirst" | "retry" | "downloadHebrewDictionary" | "useLocalServices";
  /** Argument for the action (model name for `pullModel`). */
  arg?: string;
  url?: string;
}

export interface DoctorFinding {
  id: string;
  /** i18n key of the check's title (`ai.doctor.check.<id>`). */
  title: string;
  status: DoctorStatus;
  /** Human detail, already resolved (model names, versions, URLs). */
  detail?: string;
  fix?: DoctorFix;
  ms?: number;
}

export interface DoctorReport {
  at: number;
  origin: string;
  findings: DoctorFinding[];
  summary: Record<DoctorStatus, number>;
}

export interface DoctorOptions {
  signal?: AbortSignal;
  /** Also run one golden case per agent (slow: real model calls). */
  golden?: boolean;
  /** Per-request timeout for network probes. */
  timeoutMs?: number;
  /** Stage-6 engine probes (tests); see ./doctorEngines.ts. */
  engines?: Partial<import("./doctorEngines").EngineProbe>;
}

/** The local services of docker/local-ai.yml, and the addresses the app uses for them. */
export const LOCAL_SERVICES = { grammar: "http://localhost:8010/v2/check", research: "http://localhost:8787" } as const;
const DOCKER_UP = "docker compose -f docker/local-ai.yml up -d";

export const RECOMMENDED_EMBED_MODEL = "nomic-embed-text";

function t_he(ok: boolean): string {
  return ok ? "Hebrew: a model with good Hebrew is installed" : "Hebrew: no installed model has good Hebrew";
}

function pageOrigin(): string {
  try {
    return typeof location !== "undefined" ? location.origin : "";
  } catch {
    return "";
  }
}

/** `OLLAMA_ORIGINS` value this page needs: its own origin (plus localhost for dev). */
export function ollamaOriginsFor(origin = pageOrigin()): string {
  const set = new Set<string>();
  if (origin && !/^https?:\/\/localhost/.test(origin)) set.add(origin);
  set.add("http://localhost:*");
  return [...set].join(",");
}

/** The shell lines that make Ollama accept this page, per platform. */
export function ollamaOriginsCommand(origin = pageOrigin()): string {
  const value = ollamaOriginsFor(origin);
  return [
    `# macOS (then restart Ollama):`,
    `launchctl setenv OLLAMA_ORIGINS "${value}"`,
    `# Linux (systemd): systemctl edit ollama → [Service] Environment="OLLAMA_ORIGINS=${value}"`,
    `# Windows: setx OLLAMA_ORIGINS "${value}"`,
  ].join("\n");
}

export function compareVersions(a: string, b: readonly number[]): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < b.length; i++) {
    const d = (pa[i] ?? 0) - b[i];
    if (d !== 0) return d;
  }
  return 0;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const v = await fn();
  return [v, Date.now() - t0];
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type Probe = { status: number; json: unknown } | { error: string; status?: number };

async function probe(url: string, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<Probe> {
  try {
    const res = await fetch(url, { signal: withTimeout(opts.signal, opts.timeoutMs) });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (e) {
    const err = e as Error & { status?: number };
    return { error: err.name === "TimeoutError" ? "timeout" : err.message || String(e), status: err.status };
  }
}

/**
 * Run the diagnosis. Never throws; every check reports its own status.
 * `deps` exist for tests — production callers pass nothing.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const findings: DoctorFinding[] = [];
  const push = (f: DoctorFinding) => findings.push(f);
  const origin = pageOrigin();

  const [{ getAiPolicy, isLocalOrigin }, { getBaseUrl, getOllamaConfigModel }, { connectAllowedByCsp }, executors] = await Promise.all([
    import("../ai/policy"),
    import("../ai/ollamaProvider"),
    import("../lib/cspConnect"),
    import("./executors"),
  ]);

  // 1. Policy and executor preference — context for everything below.
  const policy = getAiPolicy();
  const pref = executors.preferredExecutor();
  push({ id: "policy", title: "ai.doctor.check.policy", status: "ok", detail: `${policy} · ${pref ?? "auto"}` });

  // 2. Ollama: can the page even reach it?
  const base = getBaseUrl();
  let ollamaUp = false;
  let version: string | null = null;
  if (!connectAllowedByCsp(base)) {
    push({ id: "ollama.csp", title: "ai.doctor.check.ollama", status: "fail", detail: base, fix: { label: "ai.doctor.fix.csp", command: `VITE_CSP_CONNECT_EXTRA=${new URL(base).origin} npm run build` } });
  } else if (policy === "local-only" && !isLocalOrigin(base)) {
    push({ id: "ollama.remote", title: "ai.doctor.check.ollama", status: "fail", detail: base, fix: { label: "ai.doctor.fix.remote", action: "openSettings" } });
  } else {
    const [v, ms] = await timed(() => probe(`${base}/api/version`, { signal: opts.signal, timeoutMs }));
    if ("error" in v) {
      push({
        id: "ollama.reach",
        title: "ai.doctor.check.ollama",
        status: "fail",
        detail: `${base} — ${v.error}`,
        ms,
        fix: { label: "ai.doctor.fix.install", command: `# https://ollama.com/download\nollama serve`, url: "https://ollama.com/download" },
      });
    } else if (v.status === 403) {
      push({ id: "ollama.cors", title: "ai.doctor.check.ollama", status: "fail", detail: `403 — OLLAMA_ORIGINS`, ms, fix: { label: "ai.doctor.fix.origins", command: ollamaOriginsCommand(origin) } });
    } else if (v.status >= 400) {
      push({ id: "ollama.reach", title: "ai.doctor.check.ollama", status: "fail", detail: `${base} — HTTP ${v.status}`, ms, fix: { label: "ai.doctor.fix.install", command: "ollama serve" } });
    } else {
      ollamaUp = true;
      version = ((v.json as { version?: string } | null)?.version ?? "").trim() || null;
      push({ id: "ollama.reach", title: "ai.doctor.check.ollama", status: "ok", detail: `${base}${version ? ` · v${version}` : ""}`, ms });
      if (version && compareVersions(version, [0, 5, 0]) < 0) {
        push({ id: "ollama.version", title: "ai.doctor.check.ollamaVersion", status: "warn", detail: `v${version} < 0.5.0`, fix: { label: "ai.doctor.fix.update", command: "# update Ollama from https://ollama.com/download", url: "https://ollama.com/download" } });
      } else {
        push({ id: "ollama.version", title: "ai.doctor.check.ollamaVersion", status: version ? "ok" : "skip", detail: version ? `v${version}` : undefined });
      }
    }
  }

  // 3. Ollama models: a chat model, the recommended one, an embedding model, tool support.
  if (ollamaUp) {
    const { ollamaExecutor } = await import("./executors/ollama");
    // The model to suggest depends on the notes' language and the RAM (T27).
    const { recommendOllamaModel, prefersHebrew, hebrewSupportOf } = await import("../ai/modelCatalog");
    const { useAppStore } = await import("../store/useStore");
    const st = useAppStore.getState();
    const hebrew = prefersHebrew(st.locale, st.doc.content);
    const ramGB = typeof navigator !== "undefined" ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null) : null;
    const RECOMMENDED_OLLAMA_MODEL = recommendOllamaModel({ hebrew, ramGB }).name;
    // The tool-calling repair must name a model that calls tools (the best
    // Hebrew model may not).
    const RECOMMENDED_TOOL_MODEL = recommendOllamaModel({ hebrew, ramGB, tools: true }).name;
    const tags = await probe(`${base}/api/tags`, { signal: opts.signal, timeoutMs });
    const models: string[] = "json" in tags ? (((tags.json as { models?: Array<{ name: string }> } | null)?.models ?? []).map((m) => m.name)) : [];
    const chat = models.filter((m) => !/embed/i.test(m));
    const embed = models.filter((m) => /embed|minilm|bge-m3/i.test(m));
    const configured = getOllamaConfigModel();
    if (chat.length === 0) {
      push({ id: "ollama.models", title: "ai.doctor.check.models", status: "fail", detail: models.length ? models.join(", ") : "—", fix: { label: "ai.doctor.fix.pull", command: `ollama pull ${RECOMMENDED_OLLAMA_MODEL}`, action: "pullModel", arg: RECOMMENDED_OLLAMA_MODEL } });
    } else {
      const hasRecommended = chat.some((m) => m === RECOMMENDED_OLLAMA_MODEL || m.startsWith(RECOMMENDED_OLLAMA_MODEL + "-") || m.split(":")[0] === RECOMMENDED_OLLAMA_MODEL.split(":")[0]);
      // For Hebrew notes, a model with good Hebrew already installed counts.
      const hebrewOk = !hebrew || chat.some((m) => ["strong", "good"].includes(hebrewSupportOf(m) ?? ""));
      push({
        id: "ollama.models",
        title: "ai.doctor.check.models",
        status: hasRecommended || hebrewOk ? "ok" : "warn",
        detail: chat.join(", ") + (hebrew ? ` · ${t_he(hebrewOk)}` : ""),
        fix: hasRecommended || hebrewOk ? undefined : { label: hebrew ? "ai.doctor.fix.pullHebrew" : "ai.doctor.fix.pull", command: `ollama pull ${RECOMMENDED_OLLAMA_MODEL}`, action: "pullModel", arg: RECOMMENDED_OLLAMA_MODEL },
      });
      const configuredInstalled = chat.some((m) => m === configured || m.split(":")[0] === configured.split(":")[0]);
      if (!configuredInstalled) {
        push({ id: "ollama.configured", title: "ai.doctor.check.configuredModel", status: "warn", detail: configured, fix: { label: "ai.doctor.fix.pull", command: `ollama pull ${configured}`, action: "pullModel", arg: configured } });
      }
      // Tool calling: the committer/tasker agents need it.
      let toolsOk: boolean | null = null;
      try {
        const avail = await ollamaExecutor.available();
        if (avail.available) toolsOk = ollamaExecutor.supportsTools(ollamaExecutor.modelFor("small", { tools: true }));
      } catch {
        toolsOk = null;
      }
      push({
        id: "ollama.tools",
        title: "ai.doctor.check.tools",
        status: toolsOk === null ? "skip" : toolsOk ? "ok" : "warn",
        detail: toolsOk === null ? undefined : ollamaExecutor.modelFor("small", { tools: true }),
        fix: toolsOk === false ? { label: "ai.doctor.fix.pull", command: `ollama pull ${RECOMMENDED_TOOL_MODEL}`, action: "pullModel", arg: RECOMMENDED_TOOL_MODEL } : undefined,
      });
    }
    push({
      id: "ollama.embed",
      title: "ai.doctor.check.embed",
      status: embed.length ? "ok" : "warn",
      detail: embed.length ? embed.join(", ") : undefined,
      fix: embed.length ? undefined : { label: "ai.doctor.fix.pull", command: `ollama pull ${RECOMMENDED_EMBED_MODEL}`, action: "pullModel", arg: RECOMMENDED_EMBED_MODEL },
    });
  }

  // 4. In-browser model: WebGPU, f16, a model that fits.
  try {
    const mm = await import("../ai/modelManager");
    const hw = await mm.detectHardware();
    if (!hw.webgpu) {
      push({ id: "webgpu", title: "ai.doctor.check.webgpu", status: ollamaUp ? "warn" : "fail", detail: hw.reason, fix: { label: "ai.doctor.fix.webgpu", url: "https://caniuse.com/webgpu" } });
    } else {
      const budget = mm.vramBudgetMB(hw);
      const pick = mm.recommendWebLlmModel("small", hw);
      push({ id: "webgpu", title: "ai.doctor.check.webgpu", status: "ok", detail: `f16 ${hw.f16 ? "✓" : "✗"} · ${budget} MB · ${pick}` });
    }
  } catch (e) {
    push({ id: "webgpu", title: "ai.doctor.check.webgpu", status: "skip", detail: (e as Error).message });
  }

  // 5. transformers.js (embeddings/whisper in the browser): WebAssembly and threads.
  {
    const wasm = typeof WebAssembly !== "undefined";
    const threads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
    push({ id: "wasm", title: "ai.doctor.check.wasm", status: wasm ? (threads ? "ok" : "warn") : "fail", detail: wasm ? (threads ? "SIMD + threads" : "single-threaded (no cross-origin isolation)") : "no WebAssembly" });
  }

  // 6. Storage: quota, usage, durable?
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (!nav?.storage?.estimate) {
      push({ id: "storage", title: "ai.doctor.check.storage", status: "skip" });
    } else {
      const est = await nav.storage.estimate();
      const mb = (n?: number) => (typeof n === "number" ? Math.round(n / (1024 * 1024)) : null);
      const used = mb(est.usage);
      const quota = mb(est.quota);
      const persisted = typeof nav.storage.persisted === "function" ? await nav.storage.persisted() : null;
      const low = used !== null && quota !== null && quota - used < 200;
      push({
        id: "storage",
        title: "ai.doctor.check.storage",
        status: low ? "fail" : persisted === false ? "warn" : "ok",
        detail: `${used ?? "?"} / ${quota ?? "?"} MB${persisted === null ? "" : persisted ? " · durable" : " · evictable"}`,
        fix: persisted === false ? { label: "ai.doctor.fix.persist", action: "persist" } : undefined,
      });
    }
  } catch (e) {
    push({ id: "storage", title: "ai.doctor.check.storage", status: "skip", detail: (e as Error).message });
  }

  // 7. Service worker: offline shell.
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (!nav?.serviceWorker) push({ id: "sw", title: "ai.doctor.check.sw", status: "skip" });
    else {
      const reg = await nav.serviceWorker.getRegistration();
      push({ id: "sw", title: "ai.doctor.check.sw", status: reg ? "ok" : "warn", detail: reg ? (reg.active ? "active" : "installing") : undefined });
    }
  } catch (e) {
    push({ id: "sw", title: "ai.doctor.check.sw", status: "skip", detail: (e as Error).message });
  }

  // 8. Local services: grammar (LanguageTool) and research (SearXNG / worker).
  // First, can this build reach them at all (CSP connect-src, 7.4.1)?
  {
    const blocked = Object.values(LOCAL_SERVICES).filter((u) => !connectAllowedByCsp(u)).map((u) => new URL(u).origin);
    push({
      id: "csp.local",
      title: "ai.doctor.check.cspLocal",
      status: blocked.length ? "fail" : "ok",
      detail: blocked.length ? blocked.join(", ") : Object.values(LOCAL_SERVICES).map((u) => new URL(u).port).join(", "),
      fix: blocked.length ? { label: "ai.doctor.fix.csp", command: `VITE_CSP_CONNECT_EXTRA="${blocked.join(" ")}" npm run build` } : undefined,
    });
  }
  {
    const { grammarEndpoint } = await import("../ai/grammar");
    const g = grammarEndpoint();
    const local = isLocalOrigin(g);
    if (policy === "local-only" && !local) {
      // English spelling still works on the device (6.10); LanguageTool needs the local service.
      push({ id: "grammar", title: "ai.doctor.check.grammar", status: "warn", detail: g, fix: { label: "ai.doctor.fix.docker", command: DOCKER_UP, action: "useLocalServices" } });
    } else {
      const [r, ms] = await timed(() => probe(g.replace(/\/check$/, "/languages"), { signal: opts.signal, timeoutMs }));
      const bad = "error" in r || r.status >= 400;
      push({
        id: "grammar",
        title: "ai.doctor.check.grammar",
        status: bad ? "warn" : "ok",
        detail: `${g}${"error" in r ? ` — ${r.error}` : !bad ? "" : ` — HTTP ${r.status}`}`,
        ms,
        fix: !bad ? undefined : local ? { label: "ai.doctor.fix.docker", command: DOCKER_UP } : { label: "ai.doctor.fix.docker", command: DOCKER_UP, action: "useLocalServices" },
      });
    }
    const { researchEndpoint } = await import("../research/client");
    const re = researchEndpoint();
    if (!re) push({ id: "research", title: "ai.doctor.check.research", status: "skip", fix: { label: "ai.doctor.fix.research", command: DOCKER_UP, action: "useLocalServices" } });
    else {
      const [r, ms] = await timed(() => probe(`${re}/healthz`, { signal: opts.signal, timeoutMs }));
      const bad = "error" in r || r.status >= 400;
      push({
        id: "research",
        title: "ai.doctor.check.research",
        status: bad ? "warn" : "ok",
        detail: `${re}${"error" in r ? ` — ${r.error}` : !bad ? "" : ` — HTTP ${r.status}`}`,
        ms,
        fix: !bad ? undefined : isLocalOrigin(re) ? { label: "ai.doctor.fix.docker", command: DOCKER_UP } : { label: "ai.doctor.fix.research", action: "openSettings" },
      });
    }
  }

  // 8b. The on-device engines of stage 6 (translation, spelling, niqqud, captions).
  try {
    const { engineFindings } = await import("./doctorEngines");
    for (const f of await engineFindings(opts.engines)) push(f);
  } catch (e) {
    push({ id: "engines", title: "ai.doctor.check.engines", status: "skip", detail: (e as Error).message });
  }

  // 9. Which executor would the runtime pick right now?
  try {
    const pick = await executors.pickExecutor();
    push({
      id: "executor",
      title: "ai.doctor.check.executor",
      status: pick.executor ? "ok" : "fail",
      detail: pick.executor ? pick.executor.id : pick.skipped.map((u) => `${u.id}: ${u.availability.reason ?? "unavailable"}`).join(" · "),
      fix: pick.executor ? undefined : policy === "local-only" ? { label: "ai.doctor.fix.install", command: "ollama serve" } : { label: "ai.doctor.fix.settings", action: "openSettings" },
    });
  } catch (e) {
    push({ id: "executor", title: "ai.doctor.check.executor", status: "skip", detail: (e as Error).message });
  }

  // 10. Golden cases: one fixture per agent through the real runtime.
  if (opts.golden) {
    const { EVAL_CASES } = await import("./eval/fixtures");
    const { runEvalCase } = await import("./eval/run");
    const { passed } = await import("./eval/score");
    // Every registered agent gets a row (7.4.3); one without a case says so.
    const { listAgents } = await import("./registry");
    await import("./defs");
    for (const id of listAgents().map((a) => a.id).sort()) {
      if (!EVAL_CASES.some((c) => c.agent === id)) push({ id: `golden.${id}`, title: "ai.doctor.check.golden", status: "skip", detail: `${id} · no golden case (plan 7.3)` });
    }
    const seen = new Set<string>();
    for (const c of EVAL_CASES) {
      if (seen.has(c.agent)) continue;
      seen.add(c.agent);
      if (opts.signal?.aborted) break;
      const r = await runEvalCase(c, { signal: opts.signal });
      const ok = passed(r);
      const failed = r.checks.filter((k) => !k.ok).map((k) => `${k.check.type}: ${k.detail}`);
      push({
        id: `golden.${c.agent}`,
        title: "ai.doctor.check.golden",
        status: r.status === "skipped" ? "skip" : ok ? "ok" : "fail",
        detail: `${c.agent} · ${r.executor ?? "—"}${r.model ? ` · ${r.model}` : ""}${r.error ? ` — ${r.error}` : failed.length ? ` — ${failed.join(", ")}` : ""}`,
        ms: r.ms,
      });
    }
  }

  const summary: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const f of findings) summary[f.status]++;
  return { at: Date.now(), origin, findings, summary };
}

/** The executors a report says are usable, for callers that only need the gist. */
export function usableExecutors(report: DoctorReport): ExecutorId[] {
  const out: ExecutorId[] = [];
  if (report.findings.some((f) => f.id === "ollama.reach" && f.status === "ok")) out.push("ollama");
  if (report.findings.some((f) => f.id === "webgpu" && f.status === "ok")) out.push("webllm");
  return out;
}

/** Plain-text report for copying into a bug report. */
export function formatDoctorReport(report: DoctorReport, titleOf: (key: string) => string = (k) => k): string {
  const mark: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "–" };
  const lines = [`Lumen AI doctor · ${new Date(report.at).toISOString()} · ${report.origin}`, ""];
  for (const f of report.findings) {
    lines.push(`${mark[f.status]} ${titleOf(f.title)}${f.detail ? ` — ${f.detail}` : ""}${typeof f.ms === "number" ? ` (${f.ms} ms)` : ""}`);
    if (f.fix?.command) for (const l of f.fix.command.split("\n")) lines.push(`    ${l}`);
  }
  lines.push("", `ok ${report.summary.ok} · warn ${report.summary.warn} · fail ${report.summary.fail} · skipped ${report.summary.skip}`);
  return lines.join("\n");
}
