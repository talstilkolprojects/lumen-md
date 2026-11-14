/**
 * The slides and the presenter view talk over a BroadcastChannel (plan
 * W2.17): the presenter view is the app itself in another window
 * (`#lumen-presenter`), on the web a pop-up and on the desktop a second
 * window (src-tauri: open_presenter_window). Same origin, so nothing
 * leaves the device.
 */

export const CHANNEL = "lumen-slides";
export const PRESENTER_HASH = "#lumen-presenter";

export interface SharedSlide {
  title: string;
  notes: string;
  dir: "ltr" | "rtl";
  /** The rendered slide, as HTML (sanitised again where it is shown). */
  html: string;
}

export type SlidesMessage =
  | { type: "state"; deck: string; title: string; index: number; slides: SharedSlide[]; startedAt: number }
  | { type: "index"; deck: string; index: number }
  | { type: "go"; deck: string; index: number }
  | { type: "hello" }
  | { type: "end"; deck: string };

export function openChannel(onMessage: (m: SlidesMessage) => void): { post(m: SlidesMessage): void; close(): void } | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent<SlidesMessage>) => onMessage(e.data);
  return { post: (m) => ch.postMessage(m), close: () => ch.close() };
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Open the presenter view: a second desktop window (slides to the other screen when there is one), else a pop-up. */
export async function openPresenterWindow(): Promise<"desktop" | "popup" | "blocked"> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_presenter_window");
      return "desktop";
    } catch {
      // why: not the desktop app (or no presenter window): the browser window is used
      /* fall back to a pop-up */
    }
  }
  const url = `${location.pathname}${location.search}${PRESENTER_HASH}`;
  const w = window.open(url, "lumen-presenter", "popup,width=1100,height=720");
  return w ? "popup" : "blocked";
}

export async function closePresenterWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_presenter_window");
  } catch {
    // why: not the desktop app, or the presenter window is already closed
    /* nothing open */
  }
}
