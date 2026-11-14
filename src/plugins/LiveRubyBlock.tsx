/**
 * Live Ruby block (```live-ruby / ```ruby-live) — runs the fence body in
 * CRuby 3.4 compiled to WebAssembly (ruby.wasm) inside a Web Worker. Nothing
 * loads until the user clicks Run; the runtime (~30 MB, cached afterwards)
 * is self-hosted under /ruby/ — no CDN, CSP-safe, works offline. The worker
 * has no network or storage access, and every run gets a fresh VM. See
 * ./ruby/rubyRuntime.ts for the protocol and isolation details.
 */
import { useEffect, useRef, useState } from "react";
import { Code2, Play, Square, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { DEFAULT_RUBY_TIMEOUT_MS, type RubyRunRequest, type RubyWorkerMessage } from "./ruby/rubyRuntime";
import { RUBY_KILLED_EVENT, killRubyWorker, nextRubyRunId, rubyTurn, rubyWorker } from "./ruby/rubyClient";
import "./liveRubyBlockStrings";

interface Props {
  source: string;
  meta?: string;
}

type RunState = "idle" | "loading" | "running" | "success" | "error" | "timeout";

interface Line {
  id: number;
  kind: "out" | "err" | "result" | "error";
  text: string;
}

/** Downloading + compiling the runtime on a slow connection. */
const LOAD_TIMEOUT_MS = 180_000;

function parseTimeout(meta?: string): number {
  const m = meta?.match(/timeout=(\d+)/);
  const v = m ? Number(m[1]) : DEFAULT_RUBY_TIMEOUT_MS;
  return Math.min(Math.max(v, 500), 300_000);
}

export default function LiveRubyBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 240;
  const timeoutMs = parseTimeout(meta);
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<RunState>("idle");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [showSource, setShowSource] = useState(false);
  const runRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const lineId = useRef(0);
  // Set while this block's run holds the shared worker (its turn came).
  const activeWorker = useRef<Worker | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  /** Forget the current run (queued or active) and give up its turn. */
  const detach = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    runRef.current = null;
    activeWorker.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
  };

  // Unmounted mid-run (e.g. another document opened): the hard timeout
  // goes with the UI, so stop the Ruby code now instead of letting a
  // runaway loop hold the shared worker forever.
  useEffect(
    () => () => {
      // Only a run that holds the worker is stopped; a queued one just leaves.
      const busyWorker = runRef.current !== null ? activeWorker.current : null;
      detach();
      if (busyWorker) killRubyWorker(busyWorker);
    },
    [],
  );

  const push = (kind: Line["kind"], text: string) =>
    setLines((prev) => {
      // Coalesce consecutive chunks of the same stream (print without newline).
      const last = prev[prev.length - 1];
      if ((kind === "out" || kind === "err") && last?.kind === kind && !last.text.endsWith("\n")) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: ++lineId.current, kind, text }].slice(-500);
    });

  async function run() {
    detach();
    const runId = nextRubyRunId();
    runRef.current = runId;
    setLines([]);
    setElapsed(null);
    setState("loading");
    const turn = rubyTurn();
    releaseRef.current = turn.release;
    await turn.ready;
    if (runRef.current !== runId) {
      turn.release(); // Stopped or unmounted while queued
      return;
    }
    let worker: Worker;
    try {
      worker = rubyWorker();
    } catch (err) {
      detach();
      setState("error");
      push("error", `${t("block.liveRuby.loadFailed")} ${(err as Error).message}`);
      return;
    }
    activeWorker.current = worker;
    let hadError = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number, text: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (runRef.current !== runId) return;
        // A synchronous Ruby eval can't be interrupted: kill the worker.
        detach();
        killRubyWorker(worker);
        push("error", text);
        setState("timeout");
      }, ms);
    };

    const onMessage = (e: MessageEvent<RubyWorkerMessage>) => {
      const msg = e.data;
      if (!msg || msg.runId !== runId || runRef.current !== runId) return;
      if (msg.type === "ready") {
        setState("running");
        arm(timeoutMs, t("block.liveRuby.timedOut", { ms: timeoutMs }));
      } else if (msg.type === "output") push(msg.stream, msg.text);
      else if (msg.type === "result") push("result", `=> ${msg.text}`);
      else if (msg.type === "error") {
        hadError = true;
        push("error", msg.message);
      } else if (msg.type === "done") {
        setElapsed(msg.ms);
        setState(hadError ? "error" : "success");
        detach();
      }
    };
    const onError = (e: ErrorEvent) => {
      e.preventDefault();
      if (runRef.current !== runId) return;
      detach();
      killRubyWorker(worker);
      push("error", `${t("block.liveRuby.loadFailed")} ${e.message ?? ""}`.trim());
      setState("error");
    };
    // Another block's Stop/timeout terminated the shared worker mid-run.
    const onKilled = () => {
      if (runRef.current !== runId) return;
      detach();
      push("error", t("block.liveRuby.stopped"));
      setState("error");
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener(RUBY_KILLED_EVENT, onKilled);
    cleanupRef.current = () => {
      if (timer) clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener(RUBY_KILLED_EVENT, onKilled);
    };
    arm(LOAD_TIMEOUT_MS, t("block.liveRuby.loadTimeout"));
    worker.postMessage({ type: "run", runId, source } satisfies RubyRunRequest);
  }

  function cancel() {
    // Terminate the worker only if this run holds it; a queued run is
    // simply dropped from the line.
    const busyWorker = activeWorker.current;
    detach();
    if (busyWorker) killRubyWorker(busyWorker);
    push("error", t("block.liveRuby.stopped"));
    setState("error");
  }

  const busy = state === "loading" || state === "running";
  const stateLabel = {
    idle: t("block.liveRuby.state.idle"),
    loading: t("block.liveRuby.state.loading"),
    running: t("block.liveRuby.state.running"),
    success: t("block.liveRuby.state.success"),
    error: t("block.liveRuby.state.error"),
    timeout: t("block.liveRuby.state.timeout"),
  }[state];
  const failed = state === "error" || state === "timeout";
  const color = (k: Line["kind"]) =>
    k === "error" ? "hsl(0 80% 65%)" : k === "err" ? "hsl(40 90% 55%)" : k === "result" ? "hsl(220 14% 65%)" : "hsl(var(--fg))";

  return (
    <div className="chart-block" data-testid="live-ruby" data-state={state}>
      <div className="chart-block-header">
        <span>{t("block.liveRuby.title")}</span>
        <div className="chart-block-tabs">
          {busy ? (
            <button type="button" className="chart-block-tab" onClick={cancel} title={t("block.liveRuby.stop")} aria-label={t("block.liveRuby.stop")}>
              <Square size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {t("block.liveRuby.stop")}
            </button>
          ) : (
            <button type="button" className="chart-block-tab" onClick={() => void run()} title={t("block.liveRuby.run")} aria-label={t("block.liveRuby.run")}>
              <Play size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {t("block.liveRuby.run")}
            </button>
          )}
          <button
            type="button"
            className="chart-block-tab"
            onClick={() => setLines([])}
            title={t("block.liveRuby.clear")}
            aria-label={t("block.liveRuby.clear")}
          >
            <Trash2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.liveRuby.clear")}
          </button>
          <button
            type="button"
            className={`chart-block-tab ${showSource ? "active" : ""}`}
            onClick={() => setShowSource((v) => !v)}
            aria-pressed={showSource}
            title={t("block.htmlPreview.toggleSource")}
          >
            <Code2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.htmlPreview.source")}
          </button>
        </div>
      </div>
      {showSource && (
        <pre
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
            maxHeight: 200,
            whiteSpace: "pre",
          }}
        >
          <code>{source}</code>
        </pre>
      )}
      <div style={{ marginBottom: 6, fontSize: 11, color: failed ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))", textAlign: "end" }}>
        Ruby: {stateLabel}
        {elapsed !== null && ` · ${elapsed} ms`}
      </div>
      <div
        role="log"
        aria-live="polite"
        dir="ltr"
        style={{
          maxHeight: height,
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
          <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic" }}>
            {state === "idle" ? t("block.liveRuby.prompt") : state === "loading" ? t("block.liveRuby.loading") : t("block.liveJs.noOutput")}
          </span>
        ) : (
          lines.map((l) => (
            <div key={l.id} style={{ color: color(l.kind) }}>
              {l.text.replace(/\n$/, "")}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
