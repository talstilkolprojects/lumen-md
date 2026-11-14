/**
 * Shared webR (R compiled to WebAssembly) instance for ```live-r blocks.
 * Booted on the first Run and reused by every R block on the page. webR is
 * served same-origin under /webr/: the user's own download (webrInstall.ts,
 * plan W1.34: webR is GPL-3.0 and Lumen's build ships none of it) from the
 * service worker's runtime cache, or a deployment's own copy
 * (`npm run webr:local`). Either way it works offline once there. webR
 * runs R in its own worker; the PostMessage channel is used because the app
 * is not cross-origin isolated (no SharedArrayBuffer).
 */
import type { WebR as WebRType } from "webr";
import { loadWebRModule } from "./webrModule";
import { webrBaseUrl } from "./webrPaths";

export { webrBaseUrl };

export interface ROutputLine {
  kind: "out" | "err" | "warn" | "msg";
  text: string;
}

export interface RRunResult {
  lines: ROutputLine[];
  images: ImageBitmap[];
}

let instance: Promise<WebRType> | null = null;

/** Download + boot budget for the runtime (~45 MB on a slow connection). */
export const BOOT_TIMEOUT_MS = 180_000;

/** Is webR on this device (downloaded) or served by this deployment? */
export async function webrAvailable(): Promise<boolean> {
  const { webrAvailable: available } = await import("./webrInstall");
  return available();
}

/** Boot (once) and return the shared webR instance. */
export function getWebR(): Promise<WebRType> {
  if (!instance) {
    instance = (async () => {
      const { WebR, ChannelType } = await loadWebRModule();
      const webR = new WebR({
        baseUrl: webrBaseUrl(),
        channelType: ChannelType.PostMessage,
        interactive: false,
      });
      // A boot that hangs (never settles) must not stay cached for every
      // later Run, whichever block started it: give up after the budget.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            webR.close();
          } catch {
            /* why: not started */
          }
          reject(new Error("webR boot timed out"));
        }, BOOT_TIMEOUT_MS);
      });
      try {
        await Promise.race([webR.init(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
      return webR;
    })();
    const boot = instance;
    boot.catch(() => {
      // Let a later Run retry — unless a reset already replaced this boot.
      if (instance === boot) instance = null;
    });
  }
  return instance;
}

/** Tear the shared runtime down (after a timeout); the next Run boots a fresh one. */
export async function resetWebR(): Promise<void> {
  const cur = instance;
  instance = null;
  try {
    (await cur)?.close();
  } catch {
    /* why: already gone */
  }
}

/** Map webR's captured output entries to display lines. */
/** Caps on what one run shows (characters / lines), like the other live blocks. */
export const MAX_OUTPUT_CHARS = 200_000;
export const MAX_OUTPUT_LINES = 2_000;

export function toLines(output: ReadonlyArray<{ type: string; data: unknown }>): ROutputLine[] {
  const lines: ROutputLine[] = [];
  let chars = 0;
  for (const o of output) {
    let text =
      typeof o.data === "string"
        ? o.data
        : o.data && typeof (o.data as { message?: unknown }).message === "string"
          ? (o.data as { message: string }).message
          : String(o.data);
    const kind: ROutputLine["kind"] =
      o.type === "stdout" ? "out" : o.type === "warning" ? "warn" : o.type === "message" ? "msg" : "err";
    const room = MAX_OUTPUT_CHARS - chars;
    const full = lines.length >= MAX_OUTPUT_LINES || room <= 0;
    if (!full && text.length > room) text = text.slice(0, room);
    if (full || text.length < (typeof o.data === "string" ? o.data.length : text.length)) {
      if (!full) lines.push({ kind, text });
      lines.push({ kind: "msg", text: "… output truncated" });
      break;
    }
    chars += text.length;
    lines.push({ kind, text });
  }
  return lines;
}

/** Plot pages one run shows; later pages are dropped (and their bitmaps closed). */
export const MAX_PLOT_PAGES = 20;

const closeBitmap = (b: ImageBitmap | null | undefined) => {
  try {
    b?.close?.();
  } catch {
    /* why: already closed */
  }
};

/**
 * Collect plot pages from webR's output queue: each `canvasNewPage` starts a
 * page, and the latest `canvasImage` after it is that page's final state.
 * At most `max` pages are kept; superseded and dropped bitmaps are closed
 * so their memory is released. `dropped` counts pages beyond the cap.
 */
export function collectPlotPages(
  msgs: ReadonlyArray<{ type: string; data?: unknown }>,
  max = MAX_PLOT_PAGES,
): { pages: ImageBitmap[]; dropped: number } {
  const pages: Array<ImageBitmap | null> = [];
  let total = 0;
  for (const m of msgs) {
    if (m.type !== "canvas") continue;
    const data = m.data as { event?: string; image?: ImageBitmap } | undefined;
    if (data?.event === "canvasNewPage") {
      total++;
      if (pages.length < max) pages.push(null);
    } else if (data?.event === "canvasImage" && data.image) {
      if (total === 0) {
        total = 1;
        pages.push(null);
      }
      if (total > max) closeBitmap(data.image); // a page beyond the cap
      else {
        closeBitmap(pages[pages.length - 1]); // superseded by a later frame
        pages[pages.length - 1] = data.image;
      }
    }
  }
  return { pages: pages.filter((p): p is ImageBitmap => p !== null), dropped: Math.max(0, total - max) };
}

/** The kept plot pages (see collectPlotPages). */
export function plotPages(msgs: ReadonlyArray<{ type: string; data?: unknown }>): ImageBitmap[] {
  return collectPlotPages(msgs).pages;
}

export interface RRunHooks {
  /** Called when this run actually starts (after any queued runs). */
  onStart?: () => void;
  /** Checked before starting: a cancelled run is skipped (resolves null). */
  isCancelled?: () => boolean;
}

// Runs share one webR instance, its output queue and its graphics
// devices, so they execute one at a time: a run never drains or closes
// another run's plot frames.
let chain: Promise<unknown> = Promise.resolve();

/**
 * Run R code, capturing printed output, messages, warnings and plots.
 * Calls are serialised; see RRunHooks for queueing.
 */
export function runR(
  code: string,
  plot = { width: 504, height: 360 },
  hooks: RRunHooks = {},
): Promise<RRunResult | null> {
  const run = chain.then(async () => {
    if (hooks.isCancelled?.()) return null;
    // A run ahead of this one may have reset the runtime (Stop / timeout):
    // boot the replacement inside this turn but BEFORE onStart, so the
    // boot gets its own budget (BOOT_TIMEOUT_MS), not the run's timeout.
    const webR = await getWebR();
    if (hooks.isCancelled?.()) return null;
    hooks.onStart?.();
    return runROnce(webR, code, plot);
  });
  chain = run.catch(() => { /* why: the caller gets run's own rejection; this copy only keeps the queue going */ });
  return run;
}

async function runROnce(webR: WebRType, code: string, plot: { width: number; height: number }): Promise<RRunResult> {
  await webR.flush(); // drop anything left over from an earlier run
  // webR's built-in graphics capture fails over the PostMessage channel, so
  // open its canvas device ourselves and read the frames from the queue.
  await webR.evalRVoid(`webr::canvas(width = ${Math.round(plot.width)}, height = ${Math.round(plot.height)})`);
  const shelter = await new webR.Shelter();
  try {
    const res = await shelter.captureR(code, {
      withAutoprint: true,
      captureStreams: true,
      captureConditions: true,
      captureGraphics: false,
      throwJsException: false,
    });
    await webR.evalRVoid("while (grDevices::dev.cur() > 1) grDevices::dev.off()");
    const { pages: images, dropped } = collectPlotPages(await webR.flush());
    const lines = toLines(res.output);
    if (dropped) lines.push({ kind: "msg", text: `… ${dropped} more plot${dropped === 1 ? "" : "s"} not shown (first ${MAX_PLOT_PAGES} kept)` });
    return { lines, images };
  } finally {
    await shelter.purge();
  }
}
