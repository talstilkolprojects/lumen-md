/**
 * Web Playground block (```playground [react|vue] / ```web-playground) —
 * a small multi-file web project (HTML, CSS, JS / JSX / TS) run live in a
 * sandboxed iframe. Files are separated by `--- name.ext ---` lines; see
 * ../playground/files.ts. The iframe loads the app's own runner page
 * (`sandbox="allow-scripts"`, opaque origin: no access to the app's
 * storage), which transpiles with Sucrase and provides React / ReactDOM /
 * Vue from self-hosted copies. Each Run reloads the frame.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Play, RotateCcw, Terminal } from "lucide-react";
import { t } from "../i18n";
import { buildProject, type RunnerMessage, type RunnerRequest } from "../playground/files";

interface Props {
  source: string;
  meta?: string;
}

type RunState = "idle" | "running" | "success" | "error";
interface ConsoleLine {
  id: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
}

/** Console / error messages kept per run (the runner itself sends at most 500). */
const MAX_MESSAGES = 600;
/**
 * How long a run waits for the runner page's `ready` before saying it
 * didn't load. A host that serves the runner with the app's frame headers
 * (Netlify, A5) blocks it silently; the run still starts if it turns up.
 */
export const RUNNER_LOAD_MS = 10_000;

export function runnerUrl(base: string = import.meta.env?.BASE_URL ?? "/"): string {
  return `${base.replace(/\/?$/, "/")}playground-runner.html`;
}

export default function PlaygroundBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Math.min(Math.max(Number(heightMatch[1]), 120), 1200) : 320;
  const project = useMemo(() => buildProject(source, meta), [source, meta]);
  const [tab, setTab] = useState<string>("preview");
  const [state, setState] = useState<RunState>("idle");
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  /** The runner page hasn't said `ready` within RUNNER_LOAD_MS of this run. */
  const [stalled, setStalled] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const runRef = useRef(0);
  const lineId = useRef(0);
  /** Messages accepted for the current run (project code can post too). */
  const received = useRef(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  /** The run whose runner page has reported `ready`. */
  const readyFor = useRef(0);

  // Watch for a runner page that never loads (blocked by the host's headers).
  useEffect(() => {
    if (state !== "running") return;
    const runId = runRef.current;
    const timer = setTimeout(() => {
      if (readyFor.current !== runId && runRef.current === runId) setStalled(true);
    }, RUNNER_LOAD_MS);
    return () => clearTimeout(timer);
  }, [state, frameKey]);

  useEffect(() => {
    const onMessage = (e: MessageEvent<RunnerMessage>) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        const runId = runRef.current;
        if (!runId) return;
        readyFor.current = runId;
        setStalled(false);
        frame.contentWindow?.postMessage({ type: "run", runId, project: projectRef.current } satisfies RunnerRequest, "*");
        return;
      }
      if (msg.runId !== runRef.current) return;
      // The project's own code shares the iframe and can post messages too:
      // bound what is accepted, whatever the sender claims to be.
      if ((msg.type === "console" || msg.type === "error") && ++received.current > MAX_MESSAGES) return;
      const clip = (v: unknown) => (typeof v === "string" ? v : String(v)).slice(0, 10_000);
      if (msg.type === "console") {
        const level = (["log", "info", "warn", "error"] as const).find((l) => l === msg.level) ?? "log";
        setLines((prev) => [...prev, { id: ++lineId.current, level, text: clip(msg.text) }].slice(-500));
      } else if (msg.type === "error") {
        setLines((prev) => [...prev, { id: ++lineId.current, level: "error" as const, text: clip(msg.message) }].slice(-500));
        setState("error");
      } else if (msg.type === "done") {
        setElapsed(Number(msg.ms) || 0);
        setState((s) => (s === "error" ? s : "success"));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function run() {
    runRef.current++;
    setStalled(false);
    received.current = 0;
    setLines([]);
    setElapsed(null);
    setState("running");
    setTab((cur) => (cur === "console" ? cur : "preview"));
    setFrameKey((k) => k + 1); // a fresh document for every run
  }

  function reset() {
    runRef.current++;
    setStalled(false);
    setLines([]);
    setElapsed(null);
    setState("idle");
    setFrameKey((k) => k + 1);
  }

  const errors = lines.filter((l) => l.level === "error").length;
  const stateLabel = {
    idle: t("block.playground.state.idle"),
    running: t("block.playground.state.running"),
    success: t("block.playground.state.success"),
    error: t("block.playground.state.error"),
  }[state];
  const color = (l: ConsoleLine["level"]) =>
    l === "error" ? "hsl(0 80% 65%)" : l === "warn" ? "hsl(40 90% 55%)" : l === "info" ? "hsl(220 14% 65%)" : "hsl(var(--fg))";

  return (
    <div className="chart-block" data-testid="playground" data-state={state}>
      <div className="chart-block-header">
        <span>
          {t("block.playground.title")}
          {project.framework !== "vanilla" ? ` · ${project.framework === "react" ? "React" : "Vue"}` : ""}
        </span>
        <div className="chart-block-tabs" role="tablist">
          <button type="button" className="chart-block-tab" onClick={run} aria-label={t("block.playground.run")} title={t("block.playground.run")}>
            <Play size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.playground.run")}
          </button>
          <button type="button" className="chart-block-tab" onClick={reset} aria-label={t("block.playground.reset")} title={t("block.playground.reset")}>
            <RotateCcw size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.playground.reset")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            className={`chart-block-tab ${tab === "preview" ? "active" : ""}`}
            onClick={() => setTab("preview")}
          >
            {t("block.playground.preview")}
          </button>
          {project.files.map((f) => (
            <button
              key={f.name}
              type="button"
              role="tab"
              aria-selected={tab === `file:${f.name}`}
              className={`chart-block-tab ${tab === `file:${f.name}` ? "active" : ""}`}
              onClick={() => setTab(`file:${f.name}`)}
            >
              <Code2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {f.name}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "console"}
            className={`chart-block-tab ${tab === "console" ? "active" : ""}`}
            onClick={() => setTab("console")}
          >
            <Terminal size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.playground.console")}
            {lines.length ? ` (${lines.length})` : ""}
          </button>
        </div>
      </div>
      <div style={{ marginBottom: 6, fontSize: 11, color: state === "error" ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))", textAlign: "end" }}>
        {stateLabel}
        {elapsed !== null && ` · ${elapsed} ms`}
        {errors ? ` · ${t("block.playground.errors", { n: errors })}` : ""}
      </div>
      {stalled && (
        <div role="status" data-testid="playground-stalled" style={{ marginBottom: 6, fontSize: 12, color: "hsl(40 90% 45%)" }}>
          {t("block.playground.runnerBlocked")}
        </div>
      )}
      <div style={{ display: tab === "preview" ? "block" : "none" }}>
        {state === "idle" ? (
          <div
            style={{
              height,
              display: "grid",
              placeItems: "center",
              background: "hsl(var(--bg-subtle))",
              color: "hsl(var(--fg-muted))",
              fontStyle: "italic",
              fontSize: 12,
            }}
          >
            {t("block.playground.prompt")}
          </div>
        ) : (
          <iframe
            key={frameKey}
            ref={frameRef}
            title={t("block.playground.frameTitle")}
            src={runnerUrl()}
            sandbox="allow-scripts allow-forms allow-modals"
            style={{ width: "100%", height, border: "1px solid hsl(var(--border))", borderRadius: 4, background: "white" }}
          />
        )}
      </div>
      {project.files.map((f) =>
        tab === `file:${f.name}` ? (
          <pre
            key={f.name}
            dir="ltr"
            style={{
              margin: 0,
              padding: "0.75rem 1rem",
              background: "hsl(var(--bg-muted))",
              color: "hsl(var(--fg))",
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
              fontSize: 12,
              lineHeight: 1.55,
              overflow: "auto",
              maxHeight: height,
              whiteSpace: "pre",
            }}
          >
            <code>{f.code}</code>
          </pre>
        ) : null,
      )}
      {tab === "console" && (
        <div
          role="log"
          aria-live="polite"
          dir="ltr"
          style={{
            maxHeight: height,
            minHeight: 80,
            overflowY: "auto",
            background: "hsl(var(--bg-subtle))",
            padding: "8px 12px",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 12,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
          }}
        >
          {lines.length === 0 ? (
            <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic" }}>{t("block.liveJs.noOutput")}</span>
          ) : (
            lines.map((l) => (
              <div key={l.id} style={{ color: color(l.level) }}>
                {l.text}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
