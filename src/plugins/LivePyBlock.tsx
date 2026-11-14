/**
 * Live Python preview — runs the fence body through Pyodide (CPython on
 * WebAssembly), lazy-loaded from a CDN on first run. The ~10MB runtime is only
 * fetched when the user clicks Run, so the block costs nothing until used. A
 * single Pyodide instance is shared across blocks (cheaper, and gives REPL-ish
 * persistence of imported modules within a session).
 */
import { useRef, useState } from "react";
import { Code2, Play, Trash2 } from "lucide-react";
import { t } from "../i18n";

interface Props {
  source: string;
  meta?: string;
}

// Same-origin runtime: scripts/copy-pyodide.mjs stages the core into
// public/pyodide/ (predev/prebuild). The old jsDelivr URL was blocked by the
// app's `script-src 'self'` CSP, so live-python never ran in production —
// caught by the live-exec e2e. Same-origin also makes it work offline.
const PYODIDE_INDEX = "/pyodide/";

interface PyodideApi {
  runPythonAsync: (code: string) => Promise<unknown>;
  setStdout: (opts: { batched: (s: string) => void }) => void;
  setStderr: (opts: { batched: (s: string) => void }) => void;
}

let pyodidePromise: Promise<PyodideApi> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load pyodide.js"));
    document.head.appendChild(s);
  });
}

/** Load (once) and return the shared Pyodide instance. */
async function getPyodide(): Promise<PyodideApi> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      // Classic UMD script (not the .mjs): a same-origin <script> is a static
      // request Vite's dev server won't try to transform, and it satisfies
      // `script-src 'self'`. It registers globalThis.loadPyodide.
      await loadScript(PYODIDE_INDEX + "pyodide.js");
      const load = (globalThis as unknown as {
        loadPyodide?: (opts: { indexURL: string }) => Promise<PyodideApi>;
      }).loadPyodide;
      if (!load) throw new Error("pyodide global not found after load");
      return load({ indexURL: PYODIDE_INDEX });
    })().catch((err) => {
      // Reset so a later retry can attempt the load again.
      pyodidePromise = null;
      throw err;
    });
  }
  return pyodidePromise;
}

type RunState = "idle" | "loading" | "running" | "success" | "error";

export default function LivePyBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 240;
  const [output, setOutput] = useState("");
  const [state, setState] = useState<RunState>("idle");
  const [showSource, setShowSource] = useState(false);
  const runSeq = useRef(0);

  async function run() {
    const seq = ++runSeq.current;
    setOutput("");
    setState("loading");
    let py: PyodideApi;
    try {
      py = await getPyodide();
    } catch (err) {
      if (seq !== runSeq.current) return;
      setState("error");
      setOutput(
        `Failed to load the Python runtime (Pyodide). Check your network.\n${(err as Error).message}`,
      );
      return;
    }
    if (seq !== runSeq.current) return;

    let buf = "";
    py.setStdout({ batched: (s) => (buf += s + "\n") });
    py.setStderr({ batched: (s) => (buf += s + "\n") });
    setState("running");
    try {
      const result = await py.runPythonAsync(source);
      if (seq !== runSeq.current) return;
      if (result !== undefined && result !== null) buf += String(result);
      setOutput(buf || "(no output)");
      setState("success");
    } catch (err) {
      if (seq !== runSeq.current) return;
      setOutput(buf + (buf ? "\n" : "") + String((err as Error).message ?? err));
      setState("error");
    }
  }

  const stateLabel = {
    idle: "Not run",
    loading: "Loading Python…",
    running: "Running…",
    success: "Completed",
    error: "Error",
  }[state];

  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span>{t("block.livePy.title")}</span>
        <div className="chart-block-tabs">
          <button
            type="button"
            className="chart-block-tab"
            onClick={run}
            disabled={state === "loading" || state === "running"}
            title={t("block.livePy.run")}
            aria-label={t("block.livePy.run")}
          >
            <Play size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.common.run")}
          </button>
          <button
            type="button"
            className="chart-block-tab"
            onClick={() => setOutput("")}
            title={t("block.common.clearOutput")}
            aria-label={t("block.common.clearOutput")}
          >
            <Trash2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.common.clear")}
          </button>
          <button
            type="button"
            className={`chart-block-tab ${showSource ? "active" : ""}`}
            onClick={() => setShowSource((v) => !v)}
            aria-pressed={showSource}
            title={t("block.common.toggleSource")}
          >
            <Code2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.common.source")}
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
          color: state === "error" ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))",
          textAlign: "right",
        }}
      >
        Python: {stateLabel}
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
          whiteSpace: "pre-wrap",
          color: state === "error" ? "hsl(0 80% 65%)" : "hsl(var(--fg))",
        }}
      >
        {output || (
          <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic" }}>
            {t("block.livePy.prompt")}
          </span>
        )}
      </div>
    </div>
  );
}
