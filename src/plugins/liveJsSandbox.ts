/**
 * The app side of the live-js sandbox: a Worker-like object whose worker
 * actually lives inside a hidden `sandbox="allow-scripts"` iframe
 * (livejs-runner.html → ./liveJsRunner). The iframe has an opaque origin,
 * so the user's code can't reach the app's IndexedDB, localStorage, OPFS,
 * cookies or API tokens, and in production the runner's CSP blocks the
 * network (`connect-src 'none'`).
 *
 * Messages posted before the runner is ready are queued; terminate()
 * removes the iframe, which kills the worker with it.
 */
import type { WorkerLike, WorkerRunPayload } from "./liveJsShared";

export const RUNNER_CHANNEL = "lumen-livejs";

export type RunnerToApp =
  | { channel: typeof RUNNER_CHANNEL; kind: "ready" }
  | { channel: typeof RUNNER_CHANNEL; kind: "unavailable" }
  | { channel: typeof RUNNER_CHANNEL; kind: "message"; data: unknown }
  | { channel: typeof RUNNER_CHANNEL; kind: "error"; message: string };

export function liveJsRunnerUrl(base: string = import.meta.env?.BASE_URL ?? "/"): string {
  return `${base.replace(/\/?$/, "/")}livejs-runner.html`;
}

type MessageFn = (e: MessageEvent) => void;
type ErrorFn = (e: ErrorEvent) => void;

/** Largest relayed message the app accepts (the worker clips logs anyway). */
const MAX_MESSAGE_CHARS = 200_000;

function plainMessage(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const m = data as { type?: unknown; runId?: unknown; parts?: unknown };
  if (m.type !== "log" && m.type !== "done") return false;
  if (typeof m.runId !== "number") return false;
  if (m.parts !== undefined) {
    if (!Array.isArray(m.parts) || !m.parts.every((p) => typeof p === "string")) return false;
    if (m.parts.reduce((n: number, p: string) => n + p.length, 0) > MAX_MESSAGE_CHARS) return false;
  }
  return true;
}

export class SandboxedWorker implements WorkerLike {
  private frame: HTMLIFrameElement | null;
  private ready = false;
  private queue: unknown[] = [];
  private messageFns = new Set<MessageFn>();
  private errorFns = new Set<ErrorFn>();
  private readonly onWindowMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const msg = e.data as RunnerToApp | null;
    if (!msg || typeof msg !== "object" || msg.channel !== RUNNER_CHANNEL) return;
    if (msg.kind === "ready") {
      this.ready = true;
      for (const m of this.queue.splice(0)) this.send(m);
    } else if (msg.kind === "unavailable") {
      this.fireError("Live JS worker unavailable in this browser.");
    } else if (msg.kind === "error") {
      this.fireError(String(msg.message).slice(0, 2_000));
    } else if (msg.kind === "message" && plainMessage(msg.data)) {
      const evt = new MessageEvent("message", { data: msg.data });
      for (const fn of [...this.messageFns]) fn(evt);
    }
  };

  constructor(doc: Document = document, url: string = liveJsRunnerUrl()) {
    const frame = doc.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("data-livejs-runner", "");
    frame.title = "live-js runner";
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    frame.src = url;
    this.frame = frame;
    doc.defaultView?.addEventListener("message", this.onWindowMessage);
    doc.body.appendChild(frame);
  }

  private send(data: unknown) {
    this.frame?.contentWindow?.postMessage({ channel: RUNNER_CHANNEL, data }, "*");
  }

  private fireError(message: string) {
    const evt = new ErrorEvent("error", { message, cancelable: true });
    for (const fn of [...this.errorFns]) fn(evt);
  }

  postMessage(msg: WorkerRunPayload): void {
    if (!this.frame) return;
    if (this.ready) this.send(msg);
    else this.queue.push(msg);
  }

  addEventListener(type: "message", fn: MessageFn): void;
  addEventListener(type: "error", fn: ErrorFn): void;
  addEventListener(type: "message" | "error", fn: MessageFn | ErrorFn): void {
    if (type === "message") this.messageFns.add(fn as MessageFn);
    else this.errorFns.add(fn as ErrorFn);
  }

  removeEventListener(type: "message" | "error", fn: MessageFn | ErrorFn): void {
    if (type === "message") this.messageFns.delete(fn as MessageFn);
    else this.errorFns.delete(fn as ErrorFn);
  }

  terminate(): void {
    const frame = this.frame;
    if (!frame) return;
    this.frame = null;
    this.queue = [];
    frame.ownerDocument.defaultView?.removeEventListener("message", this.onWindowMessage);
    frame.remove();
  }
}

/** A sandboxed live-js worker, or null where iframes can't be created. */
export function makeSandboxedWorker(): SandboxedWorker | null {
  try {
    if (typeof document === "undefined" || !document.body) return null;
    return new SandboxedWorker();
  } catch {
    return null;
  }
}
