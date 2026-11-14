/**
 * Live R block (```live-r / ```r-live) — runs the fence body in R compiled
 * to WebAssembly (webR). Nothing loads until the user clicks Run. webR's
 * binaries are GPL-3.0, so Lumen does not ship them (plan W1.34): the first
 * Run on a device without webR offers the download (≈ 45 MB, licence shown
 * first, every file checked against this build's checksums), which is then
 * served same-origin from the service worker's cache — CSP-safe, offline
 * afterwards. A deployment that serves its own copy (`npm run webr:local`)
 * skips the offer. Printed output, messages, warnings, errors and
 * base-graphics plots are shown. Packages from CRAN can't be installed
 * (R's worker only reaches its own folder), but base R and the
 * recommended packages bundled with webR are available.
 */
import { useEffect, useRef, useState } from "react";
import { Code2, Download, Play, Square, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { resetWebR, runR, webrAvailable, type ROutputLine } from "./r/rRuntime";
import type { WebRInstallError, WebRManifest } from "./r/webrInstall";
import "./r/webrStrings";
import "./liveRBlockStrings";
import { explainError } from "../lib/userError";

interface Props {
  source: string;
  meta?: string;
}

type RunState = "idle" | "install" | "loading" | "running" | "success" | "error" | "timeout";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Downloading (~45 MB) and booting R on a slow connection. */
const LOAD_TIMEOUT_MS = 180_000;

function parseTimeout(meta?: string): number {
  const m = meta?.match(/timeout=(\d+)/);
  const v = m ? Number(m[1]) : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(v, 1000), 300_000);
}

function Plot({ image }: { image: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = image.width;
    c.height = image.height;
    c.getContext("2d")?.drawImage(image, 0, 0);
  }, [image]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={t("block.liveR.plot")}
      style={{ maxWidth: "100%", height: "auto", background: "white", borderRadius: 4 }}
    />
  );
}

/** An R install failure in words; the detail is explainError's sentence, never the raw text. */
function describeInstallError(e: unknown): string {
  const err = e as Partial<WebRInstallError> | null;
  const detail = explainError(e, "webr-install");
  switch (err?.code) {
    case "no-manifest":
      return t("block.liveR.install.error.noManifest");
    case "no-cache":
      return t("block.liveR.install.error.noCache");
    case "mismatch":
      return t("block.liveR.install.error.mismatch", { detail });
    default:
      return t("block.liveR.install.error.download", { detail });
  }
}

/** The offer to download webR, with its licence and source, then the download itself. */
function WebRInstallOffer({ onInstalled }: { onInstalled: () => void }) {
  const [manifest, setManifest] = useState<WebRManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    import("./r/webrInstall")
      .then((m) => m.fetchWebRManifest())
      .then(
        (m) => alive && setManifest(m),
        (e) => alive && setError(describeInstallError(e)),
      );
    return () => {
      alive = false;
      abort.current?.abort();
    };
  }, []);

  async function download() {
    if (!manifest) return;
    setError(null);
    setPercent(0);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const { installWebR } = await import("./r/webrInstall");
      await installWebR({ manifest, signal: ctrl.signal, onProgress: (done, total) => setPercent(total ? Math.floor((done / total) * 100) : 0) });
      if (ctrl.signal.aborted) return;
      setPercent(null);
      onInstalled();
    } catch (e) {
      if (ctrl.signal.aborted) {
        setPercent(null);
        return;
      }
      setPercent(null);
      setError(describeInstallError(e));
    }
  }

  const size = manifest ? (manifest.bytes / 1e6).toFixed(1) : "…";
  const version = manifest?.version ?? "…";
  return (
    <div data-testid="live-r-install" style={{ display: "grid", gap: 6, padding: "8px 12px", marginBottom: 6, background: "hsl(var(--bg-subtle))", fontSize: 12, lineHeight: 1.5 }}>
      <strong>{t("block.liveR.install.title")}</strong>
      <span>{t("block.liveR.install.body", { size, version })}</span>
      <span style={{ color: "hsl(var(--fg-muted))" }}>{t("block.liveR.install.source", { version })}</span>
      {manifest && (
        <a href={`https://github.com/r-wasm/webr/blob/v${manifest.version}/LICENSE.md`} target="_blank" rel="noopener noreferrer">
          {t("block.liveR.install.license")}
        </a>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {percent === null ? (
          <button type="button" className="chart-block-tab" disabled={!manifest} onClick={() => void download()}>
            <Download size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.liveR.install.download", { size })}
          </button>
        ) : (
          <>
            <span role="status">{t("block.liveR.install.progress", { percent })}</span>
            <button type="button" className="chart-block-tab" onClick={() => abort.current?.abort()}>
              {t("block.liveR.install.cancel")}
            </button>
          </>
        )}
      </div>
      {error && (
        <span role="alert" style={{ color: "hsl(0 80% 65%)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

export default function LiveRBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 280;
  const timeoutMs = parseTimeout(meta);
  const [lines, setLines] = useState<ROutputLine[]>([]);
  const [images, setImages] = useState<ImageBitmap[]>([]);
  // Plot bitmaps are native allocations: close the previous set when it is
  // replaced or cleared, and on unmount (canvases already hold the pixels).
  useEffect(
    () => () => {
      for (const b of images) {
        try {
          b.close?.();
        } catch {
          /* why: already closed */
        }
      }
    },
    [images],
  );
  const [state, setState] = useState<RunState>("idle");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [showSource, setShowSource] = useState(false);
  const runSeq = useRef(0);
  // True while this block's run holds the shared webR instance (it has left
  // the queue). Only then may Stop / unmount reset the runtime; a run that
  // is still queued is just skipped, so another block's run survives.
  const executing = useRef(false);

  /** Drop the current run; reset webR only if that run is executing. */
  const abandon = () => {
    runSeq.current++;
    if (executing.current) {
      executing.current = false;
      void resetWebR();
    }
  };

  useEffect(() => abandon, []);

  async function run() {
    const runId = ++runSeq.current;
    setLines([]);
    setImages([]);
    setElapsed(null);
    setState("loading");
    const started = performance.now();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const after = (ms: number) =>
      new Promise<"timeout">((resolve) => {
        timers.push(setTimeout(() => resolve("timeout"), ms));
      });
    try {
      // No webR on this device yet: offer the download (the user's choice,
      // with its GPL-3.0 licence shown); Run again once it is here.
      if (!(await webrAvailable())) {
        if (runId === runSeq.current) setState("install");
        return;
      }
      if (runId !== runSeq.current) return;
      // The first Run boots the runtime: that gets its own, longer budget,
      // so the block's `timeout=` is all execution time.
      const { getWebR } = await import("./r/rRuntime");
      const ready = await Promise.race([getWebR().then(() => "ready" as const), after(LOAD_TIMEOUT_MS)]);
      if (runId !== runSeq.current) return;
      if (ready === "timeout") {
        // A boot that hangs (never rejects) would stay cached: drop it so the
        // next Run starts a fresh instance.
        void resetWebR();
        throw new Error(t("block.liveR.loadTimeout"));
      }
      // The execution timer (and the "running" state) start when the run
      // does: other R blocks may be ahead of it in the queue, and a
      // runtime they reset is re-booted before onStart.
      let startTimer: () => void = () => {};
      const timedOut = new Promise<"timeout">((resolve) => {
        startTimer = () => timers.push(setTimeout(() => resolve("timeout"), timeoutMs));
      });
      const out = await Promise.race([
        runR(source, undefined, {
          onStart: () => {
            executing.current = true;
            setState("running");
            startTimer();
          },
          isCancelled: () => runId !== runSeq.current,
        }).finally(() => {
          if (runId === runSeq.current) executing.current = false;
        }),
        timedOut,
      ]);
      if (runId !== runSeq.current || out === null) {
        // A superseded run's plots are never shown.
        if (out && out !== "timeout") for (const b of out.images) b.close?.();
        return;
      }
      if (out === "timeout") {
        // R can't be interrupted over the PostMessage channel: drop the
        // runtime; the next Run boots a fresh one.
        executing.current = false;
        await resetWebR();
        setLines([{ kind: "err", text: t("block.liveR.timedOut", { ms: timeoutMs }) }]);
        setState("timeout");
        return;
      }
      setLines(out.lines);
      setImages(out.images);
      setElapsed(Math.round(performance.now() - started));
      setState(out.lines.some((l) => l.kind === "err") ? "error" : "success");
    } catch (err) {
      if (runId !== runSeq.current) return;
      const detail = err instanceof Error ? err.message || err.name : String(err);
      setLines([{ kind: "err", text: `${t("block.liveR.loadFailed")} ${detail}`.trim() }]);
      setState("error");
    } finally {
      for (const h of timers) clearTimeout(h);
    }
  }

  function cancel() {
    abandon();
    setLines((prev) => [...prev, { kind: "err", text: t("block.liveR.stopped") }]);
    setState("error");
  }

  const busy = state === "loading" || state === "running";
  const stateLabel = {
    idle: t("block.liveR.state.idle"),
    install: t("block.liveR.install.state"),
    loading: t("block.liveR.state.loading"),
    running: t("block.liveR.state.running"),
    success: t("block.liveR.state.success"),
    error: t("block.liveR.state.error"),
    timeout: t("block.liveR.state.timeout"),
  }[state];
  const failed = state === "error" || state === "timeout";
  const color = (k: ROutputLine["kind"]) =>
    k === "err" ? "hsl(0 80% 65%)" : k === "warn" ? "hsl(40 90% 55%)" : k === "msg" ? "hsl(220 14% 65%)" : "hsl(var(--fg))";

  return (
    <div className="chart-block" data-testid="live-r" data-state={state}>
      <div className="chart-block-header">
        <span>{t("block.liveR.title")}</span>
        <div className="chart-block-tabs">
          {busy ? (
            <button type="button" className="chart-block-tab" onClick={cancel} title={t("block.liveR.stop")} aria-label={t("block.liveR.stop")}>
              <Square size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {t("block.liveR.stop")}
            </button>
          ) : (
            <button type="button" className="chart-block-tab" onClick={() => void run()} title={t("block.liveR.run")} aria-label={t("block.liveR.run")}>
              <Play size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
              {t("block.liveR.run")}
            </button>
          )}
          <button
            type="button"
            className="chart-block-tab"
            onClick={() => {
              setLines([]);
              setImages([]);
            }}
            title={t("block.liveR.clear")}
            aria-label={t("block.liveR.clear")}
          >
            <Trash2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.liveR.clear")}
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
      {state === "install" && <WebRInstallOffer onInstalled={() => void run()} />}
      <div style={{ marginBottom: 6, fontSize: 11, color: failed ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))", textAlign: "end" }}>
        R: {stateLabel}
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
          display: "grid",
          gap: 8,
        }}
      >
        {lines.length === 0 && images.length === 0 ? (
          <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic" }}>
            {state === "idle" ? t("block.liveR.prompt") : state === "loading" ? t("block.liveR.loading") : t("block.liveJs.noOutput")}
          </span>
        ) : (
          <>
            {lines.length > 0 && (
              <div>
                {lines.map((l, i) => (
                  <div key={i} style={{ color: color(l.kind) }}>
                    {l.text.replace(/\n$/, "")}
                  </div>
                ))}
              </div>
            )}
            {images.map((img, i) => (
              <Plot key={i} image={img} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
