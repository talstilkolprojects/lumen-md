/**
 * Live JavaScript preview — type JS in the fence body and inspect
 * stdout-like console output from a dedicated worker context.
 */

import { useEffect, useRef, useState, useContext } from "react";
import { Code2, Play, RotateCcw, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { PreviewDocKeyContext, docIdentity } from "../renderer/previewDoc";
import { useAppStore } from "../store/useStore";
import { hoistTopLevelBindings } from "./liveJsScope";
import { SharedScopeRegistry, sharedScopeName } from "./liveJsShared";
import { makeSandboxedWorker, type SandboxedWorker } from "./liveJsSandbox";

type LogLevel = "log" | "info" | "warn" | "error";

interface LogEntry {
  id: number;
  level: LogLevel;
  parts: string[];
  ts: number;
}

interface Props {
  source: string;
  meta?: string;
}

interface WorkerPayload {
  type: "run";
  source: string;
  runId: number;
  timeoutMs: number;
}

interface WorkerLog {
  type: "log" | "done" | "error";
  runId: number;
  level?: LogLevel;
  parts?: string[];
}

export { WORKER_SOURCE } from "./liveJsWorkerSource";

const LEVEL_COLOR: Record<LogLevel, string> = {
  log: "hsl(var(--fg))",
  info: "hsl(220 14% 65%)",
  warn: "hsl(40 90% 60%)",
  error: "hsl(0 80% 65%)",
};

const DEFAULT_TIMEOUT_MS = 8000;
type RunState = "idle" | "running" | "success" | "error" | "timeout" | "reset";

/**
 * Documents whose live-js the user has run in this session (T48: code in a
 * document never runs just because the document was opened — the first run
 * is a click on "Run"; after that, edits re-run as before).
 */
const runApproved = new Set<string>();

/** Test hook: forget every approval. */
export function __resetLiveJsApprovals(): void {
  runApproved.clear();
}

/** One shared worker per (document, scope name) — see ./liveJsShared. */
const sharedScopes = new SharedScopeRegistry(makeSandboxedWorker);

export default function LiveJsBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 240;
  const sharedName = sharedScopeName(meta);
  // Scope per open document: two docs never see each other's globals. Use
  // the document this preview tree was rendered from — while switching
  // tabs the old tree is still on screen and must not run in the new
  // document's scope. Fall back to the store outside a document preview.
  const previewDocKey = useContext(PreviewDocKeyContext);
  const storeDocKey = useAppStore((s) => docIdentity(s.doc));
  const docKey = previewDocKey ?? storeDocKey;
  const scopeKey = sharedName ? `${docKey}\u0000${sharedName}` : null;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showSource, setShowSource] = useState(false);
  const [runId, setRunId] = useState(0);
  const [, setApprovalTick] = useState(0);
  const approved = runApproved.has(docKey ?? "");
  const [runState, setRunState] = useState<RunState>(approved ? "running" : "idle");
  const [workerErr, setWorkerErr] = useState<string | null>(null);
  const idCounter = useRef(0);
  const workerRef = useRef<SandboxedWorker | null>(null);

  // Keep the shared scope alive while any block that uses it is mounted.
  useEffect(() => {
    if (!scopeKey) return;
    return sharedScopes.acquire(scopeKey);
  }, [scopeKey]);

  useEffect(() => {
    if (!approved) {
      setRunState("idle");
      return;
    }
    setLogs([]);
    setWorkerErr(null);
    setRunState("running");
    let hadError = false;

    if (scopeKey) {
      const pushLog = (level: LogLevel, parts: string[]) => {
        if (level === "error") {
          hadError = true;
          setRunState("error");
        }
        setLogs((prev) =>
          [...prev, { id: ++idCounter.current, level, parts, ts: Date.now() }].slice(-200),
        );
      };
      const handle = sharedScopes.run(scopeKey, hoistTopLevelBindings(source), DEFAULT_TIMEOUT_MS, {
        onLog: pushLog,
        onEnd: (reason) => {
          if (reason === "timeout") {
            setWorkerErr("Live JS execution timed out.");
            setRunState("timeout");
          } else if (reason === "reset") {
            setRunState("reset");
          } else {
            setRunState(hadError ? "error" : "success");
          }
        },
      });
      if (!handle) {
        setWorkerErr("Live JS worker unavailable in this browser.");
        return;
      }
      return () => handle.detach();
    }

    const currentRun = runId;
    const worker = makeSandboxedWorker();
    if (!worker) {
      setWorkerErr("Live JS worker unavailable in this browser.");
      return;
    }
    workerRef.current = worker;

    const onMsg = (e: MessageEvent) => {
      const msg = e.data as WorkerLog;
      if (!msg || typeof msg.runId !== "number" || msg.runId !== currentRun) return;
      if (msg.type === "done") {
        setRunState(hadError ? "error" : "success");
        return;
      }
      if (!msg.level || !msg.parts) return;
      const level: LogLevel = msg.level;
      const parts: string[] = msg.parts;
      if (level === "error") {
        hadError = true;
        setRunState("error");
      }
    setLogs((prev) =>
      [...prev, {
        id: ++idCounter.current,
        level,
        parts,
        ts: Date.now(),
      }].slice(-200),
    );
  };

    // Defense-in-depth: even though the worker's own onerror /
    // onunhandledrejection suppress + preventDefault, a parent-side
    // listener guarantees no worker error escapes to window.onerror /
    // pageerror. Without this, certain browser quirks (older webkit,
    // some headless modes) can still surface a worker error event.
    const onWorkerError = (e: ErrorEvent) => {
      e.preventDefault();
      hadError = true;
      setRunState("error");
      setLogs((prev) =>
        [...prev, {
          id: ++idCounter.current,
          level: "error" as LogLevel,
          parts: [e.message ?? "Worker error"],
          ts: Date.now(),
        }].slice(-200),
      );
    };
    worker.addEventListener("error", onWorkerError);
    worker.addEventListener("message", onMsg);
    worker.postMessage({
      type: "run",
      runId: currentRun,
      source,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    } as WorkerPayload);

    const timer = setTimeout(() => {
      worker.terminate();
      setWorkerErr("Live JS execution timed out.");
      hadError = true;
      setRunState("timeout");
    }, DEFAULT_TIMEOUT_MS + 200);

    return () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onWorkerError);
      worker.terminate();
      workerRef.current = null;
    };
  }, [source, runId, scopeKey, approved]);

  function reRun() {
    runApproved.add(docKey ?? "");
    setApprovalTick((n) => n + 1);
    setLogs([]);
    setRunId((n) => n + 1);
  }

  function resetScope() {
    if (!scopeKey) return;
    sharedScopes.reset(scopeKey);
    setLogs([]);
    setWorkerErr(null);
    setRunState("reset");
  }

  const stateLabel = {
    idle: t("block.liveJs.idle"),
    running: "Running…",
    success: "Completed",
    error: "Runtime error",
    timeout: "Timed out",
    reset: t("block.liveJs.scopeReset"),
  }[runState];

  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span>
          {t("block.liveJs.title")}
          {sharedName && (
            <span
              title={t("block.liveJs.sharedHint")}
              style={{ marginInlineStart: 6, fontSize: 10, color: "hsl(var(--fg-muted))" }}
              data-testid="livejs-shared-badge"
            >
              {sharedName === "default"
                ? t("block.liveJs.shared")
                : `${t("block.liveJs.shared")} · ${sharedName}`}
            </span>
          )}
        </span>
        <div className="chart-block-tabs">
        <button
            type="button"
            className="chart-block-tab"
            onClick={reRun}
            title={t("block.liveJs.run")}
            aria-label={t("block.liveJs.run")}
          >
            <Play size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.liveJs.run")}
          </button>
          {scopeKey && (
            <button
              type="button"
              className="chart-block-tab"
              onClick={resetScope}
              title={t("block.liveJs.resetScope.hint")}
              aria-label={t("block.liveJs.resetScope")}
            >
              <RotateCcw size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {t("block.liveJs.resetScope")}
            </button>
          )}
          <button
            type="button"
            className="chart-block-tab"
            onClick={() => setLogs([])}
            title={t("block.liveJs.clear")}
            aria-label={t("block.liveJs.clear")}
          >
            <Trash2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.liveJs.clear")}
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
          color: runState === "error" || runState === "timeout" ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))",
          textAlign: "right",
        }}
      >
        {t("block.liveJs.runStatus", { state: stateLabel })}
      </div>
      <div
        role="log"
        aria-live="polite"
        style={{
          maxHeight: height,
          overflowY: "auto",
          background: "hsl(var(--bg-subtle))",
          padding: "8px 12px",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {workerErr ? (
          <div style={{ color: LEVEL_COLOR.error }}>{workerErr}</div>
        ) : runState === "idle" ? (
          <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic" }} data-testid="livejs-idle">
            {t("block.liveJs.idleHint")}
          </span>
        ) : logs.length === 0 ? (
          <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic" }}>
            {t("block.liveJs.noOutput")}
          </span>
        ) : (
          logs.map((l) => (
            <div key={l.id} style={{ color: LEVEL_COLOR[l.level], whiteSpace: "pre-wrap" }}>
              <span style={{ opacity: 0.6 }}>[{l.level}]</span> {l.parts.join(" ")}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
