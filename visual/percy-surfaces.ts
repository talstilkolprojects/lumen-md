/**
 * The 30 screens Percy snapshots (plan W7.25): the 10 surfaces of the local
 * baselines (10.3), the RTL matrix note (9.5), and 19 more views reached by
 * their palette command. Each runs in 4 variants (he / en × light / dark), and
 * Percy renders each snapshot in Chrome, Firefox and Safari: 30 × 4 × 3.
 */
import type { Page } from "@playwright/test";
import type { Surface } from "./harness";

const runCommand = (page: Page, id: string) =>
  page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** A view opened by a palette command; ready once the DOM stops changing after it (no fixed wait). */
export function commandSurface(id: string, command: string): Surface & { command: string } {
  return { id, command, open: (p) => runCommand(p, command), ready: "body" };
}

/** Waits until the page's DOM size is the same on two animation frames in a row (a command's view has rendered). */
export async function domSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const size = () => document.body.innerHTML.length;
        const a = size();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(size() === a)));
      }),
    undefined,
    { timeout: 20_000, polling: 100 },
  );
}

export const COMMAND_SURFACES = [
  commandSurface("settings", "settings.open"),
  commandSurface("organization", "settings.organization"),
  commandSurface("backlinks", "view.backlinks"),
  commandSurface("calendar", "view.calendar"),
  commandSurface("canvas", "view.canvas"),
  commandSurface("find-replace", "view.findReplace"),
  commandSurface("graph", "view.graphView"),
  commandSurface("local-graph", "view.localGraph"),
  commandSurface("highlights", "view.highlights"),
  commandSurface("outline", "view.outline"),
  commandSurface("page-view", "view.pageView"),
  commandSurface("properties", "view.properties"),
  commandSurface("reading", "view.reading"),
  commandSurface("reading-options", "view.readingOptions"),
  commandSurface("review", "view.review"),
  commandSurface("search", "view.search"),
  commandSurface("tags", "view.tags"),
  commandSurface("version-history", "view.versionHistory"),
  commandSurface("workspace", "view.workspace"),
];

/** The RTL matrix note in the preview (9.5): the screen where RTL regressions show first. */
export const RTL_MATRIX = { id: "rtl-matrix", open: (p: Page) => p.keyboard.press("Meta+3"), ready: ".prose-lumen table" } satisfies Surface;

/** The ten surfaces of harness.ts (10.3), by id: percy.percy.ts checks that harness.ts still has exactly these. */
export const BASE_SURFACE_IDS = ["split", "source", "preview", "wysiwyg", "palette", "shortcuts", "plugins", "templates", "theme-settings", "ai-settings"] as const;

/** All 30 screens, in order: the ten, the RTL matrix, the nineteen command views. */
export const PERCY_SCREEN_IDS: readonly string[] = [...BASE_SURFACE_IDS, RTL_MATRIX.id, ...COMMAND_SURFACES.map((s) => s.id)];

export function percySurfaces(base: readonly Surface[]): Surface[] {
  const ids = base.map((s) => s.id);
  if (JSON.stringify(ids) !== JSON.stringify(BASE_SURFACE_IDS)) throw new Error(`visual/harness.ts SURFACES changed (${ids.join(", ")}): update BASE_SURFACE_IDS`);
  return [...base, RTL_MATRIX, ...COMMAND_SURFACES];
}

/**
 * The deliberate 2px RTL change of the self-test (acceptance: caught in 3/3
 * browsers): RTL text in the preview moves 2px. Applied only when
 * LUMEN_PERCY_CANARY=1, in a build of its own that is never approved.
 */
export const RTL_CANARY_CSS = '[dir="rtl"] .prose-lumen { padding-inline-start: calc(var(--lumen-canary, 0px) + 2px) !important; }';
