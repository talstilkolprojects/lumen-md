/**
 * Live Lua block (```live-lua) — runs the fence body in Lua 5.4 compiled to
 * WebAssembly (wasmoon), inside a dedicated Web Worker. Nothing loads until
 * the user clicks Run; the ~270 KB wasm is a self-hosted Vite asset (no CDN,
 * CSP-safe, works offline). Each run spins up a fresh worker + Lua state, so
 * a hung script is killed by terminating the worker without touching the
 * page. See ./lua/luaRuntime.ts for the protocol and sandbox details.
 */
import { useEffect, useRef, useState } from "react";
import { Code2, Play, Square, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { DEFAULT_LUA_TIMEOUT_MS, type LuaRunRequest, type LuaWorkerMessage } from "./lua/luaRuntime";
import "./liveLuaBlockStrings";

interface Props {
  source: string;
  meta?: string;
}

type RunState = "idle" | "running" | "success" | "error" | "timeout";

interface Line {
  id: number;
  kind: "out" | "result" | "error";
  text: string;
}

/** Grace period past the in-Lua timeout before the page kills the worker. */
const HARD_KILL_GRACE_MS = 1500;

function parseTimeout(meta?: string): number {
  const m = meta?.match(/timeout=(\d+)/);
  const v = m ? Number(m[1]) : DEFAULT_LUA_TIMEOUT_MS;
  return Math.min(Math.max(v, 100), 60_000);
}

export default function LiveLuaBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 240;
  const timeoutMs = parseTimeout(meta);
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<RunState>("idle");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [showSource, setShowSource] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const killTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSeq = useRef(0);
  const lineId = useRef(0);

  function stop() {
    if (killTimer.current) clearTimeout(killTimer.current);
    killTimer.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
  }

  useEffect(() => stop, []);

  const push = (kind: Line["kind"], text: string) =>
    setLines((prev) => {
      // Coalesce consecutive stdout chunks (io.write without newline).
      const last = prev[prev.length - 1];
      if (kind === "out" && last?.kind === "out" && !last.text.endsWith("\n")) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: ++lineId.current, kind, text }].slice(-500);
    });

  function run() {
    stop();
    const runId = ++runSeq.current;
    setLines([]);
    setElapsed(null);
    setState("running");
    let worker: Worker;
    try {
      worker = new Worker(new URL("./lua/lua.worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      setState("error");
      push("error", `${t("block.liveLua.workerUnavailable")} ${(err as Error).message}`);
      return;
    }
    workerRef.current = worker;
    let hadError = false;

    worker.addEventListener("message", (e: MessageEvent<LuaWorkerMessage>) => {
      const msg = e.data;
      if (!msg || msg.runId !== runId || runId !== runSeq.current) return;
      if (msg.type === "output") push("out", msg.text);
      else if (msg.type === "result") push("result", `→ ${msg.text}`);
      else if (msg.type === "error") {
        hadError = true;
        push("error", msg.message);
        if (/timed out/i.test(msg.message)) setState("timeout");
      } else if (msg.type === "done") {
        setElapsed(msg.ms);
        setState((s) => (s === "timeout" ? s : hadError ? "error" : "success"));
        stop();
      }
    });
    worker.addEventListener("error", (e: ErrorEvent) => {
      e.preventDefault();
      if (runId !== runSeq.current) return;
      push("error", e.message || t("block.liveLua.loadFailed"));
      setState("error");
      stop();
    });
    worker.postMessage({ type: "run", runId, source, timeoutMs } satisfies LuaRunRequest);

    // The in-Lua instruction hook handles loops in Lua code, but a stuck
    // wasm call can't be interrupted from inside — kill the worker.
    killTimer.current = setTimeout(() => {
      if (runId !== runSeq.current) return;
      stop();
      push("error", t("block.liveLua.timedOut", { ms: timeoutMs }));
      setState("timeout");
    }, timeoutMs + HARD_KILL_GRACE_MS);
  }

  function cancel() {
    runSeq.current++;
    stop();
    push("error", t("block.liveLua.stopped"));
    setState("error");
  }

  const stateLabel = {
    idle: t("block.liveLua.state.idle"),
    running: t("block.liveLua.state.running"),
    success: t("block.liveLua.state.success"),
    error: t("block.liveLua.state.error"),
    timeout: t("block.liveLua.state.timeout"),
  }[state];
  const failed = state === "error" || state === "timeout";

  return (
    <div className="chart-block" data-testid="live-lua" data-state={state}>
      <div className="chart-block-header">
        <span>{t("block.liveLua.title")}</span>
        <div className="chart-block-tabs">
          {state === "running" ? (
            <button
              type="button"
              className="chart-block-tab"
              onClick={cancel}
              title={t("block.liveLua.stop")}
              aria-label={t("block.liveLua.stop")}
            >
              <Square size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {t("block.liveLua.stop")}
            </button>
          ) : (
            <button
              type="button"
              className="chart-block-tab"
              onClick={run}
              title={t("block.liveLua.run")}
              aria-label={t("block.liveLua.run")}
            >
              <Play size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {t("block.liveLua.run")}
            </button>
          )}
          <button
            type="button"
            className="chart-block-tab"
            onClick={() => setLines([])}
            title={t("block.liveLua.clear")}
            aria-label={t("block.liveLua.clear")}
          >
            <Trash2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.liveLua.clear")}
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
      <div
        style={{
          marginTop: 0,
          marginBottom: 6,
          fontSize: 11,
          color: failed ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))",
          textAlign: "end",
        }}
      >
        Lua: {stateLabel}
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
            {state === "idle" ? t("block.liveLua.prompt") : t("block.liveJs.noOutput")}
          </span>
        ) : (
          lines.map((l) => (
            <div
              key={l.id}
              style={{
                color:
                  l.kind === "error"
                    ? "hsl(0 80% 65%)"
                    : l.kind === "result"
                      ? "hsl(220 14% 65%)"
                      : "hsl(var(--fg))",
              }}
            >
              {l.text.replace(/\n$/, "")}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
