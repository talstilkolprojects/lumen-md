/**
 * The diagnostics bundle (plan W3.7): what a maintainer needs to understand
 * a problem — the version and platform, the settings, the shape of the
 * vault, the last warnings and errors — and nothing else.
 *
 * Built from an allowlist, never from "everything minus secrets": settings
 * are copied key by key (on / off switches, modes, sizes), the vault is
 * counted (notes, folders, bytes), logs come from the logger's content-free
 * ring (src/lib/logger.ts). No note text, note name, path, API key, token,
 * e-mail or collaboration room is ever read into it, and the result is
 * scanned once more before it is shown (`assertClean`).
 */
import { version as appVersion } from "../../package.json";
import { recentLogs } from "../lib/logger";
import { scrubSecrets } from "./feedback";

export interface Diagnostics {
  kind: "lumen-diagnostics";
  version: 1;
  generatedAt: string;
  app: { version: string; shell: string; platform: string; language: string; userAgent: string };
  settings: Record<string, string | number | boolean | null>;
  vault: { notes: number; otherFiles: number; folders: number; bytes: number } | null;
  storage: { opfs: boolean; persisted: boolean | null; quotaMB: number | null; usageMB: number | null };
  logs: Array<{ t: string; level: string; message: string }>;
}

/** Settings copied into the bundle, by store key — switches, modes and numbers only. */
export const SETTINGS_ALLOWLIST = [
  "mode", "theme", "locale", "showOutline", "showWorkspace", "showBacklinks", "showCalendar", "vimEnabled", "rtl", "autoSave", "autoSaveInterval",
  "syncScroll", "splitAxis", "pageView", "spellCheck", "grammarCheck", "useLocalAi", "typewriterMode", "tsChecks", "writingGoalWords", "suggestingMode", "useFineTunedModel",
] as const;

const scalar = (v: unknown): v is string | number | boolean | null => v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 40 && /^[\w .:-]*$/.test(v));

/** The allowlisted settings of a store state, plus the theme's shape and the daily-note pattern (not its template or folder). */
export function settingsOf(state: Record<string, unknown>): Diagnostics["settings"] {
  const out: Diagnostics["settings"] = {};
  for (const k of SETTINGS_ALLOWLIST) if (k in state && scalar(state[k])) out[k] = state[k] as string | number | boolean | null;
  const theme = state.themeSettings as Record<string, unknown> | undefined;
  if (theme) for (const k of ["preset", "fontFamily", "fontSize", "lineHeight", "contentWidth"]) if (scalar(theme[k])) out[`themeSettings.${k}`] = theme[k] as string | number;
  const daily = state.dailyNotes as Record<string, unknown> | undefined;
  if (daily && typeof daily.pattern === "string" && /^[YMD\-_.]{1,20}$/.test(daily.pattern)) out["dailyNotes.pattern"] = daily.pattern;
  const tabs = state.openTabs;
  if (Array.isArray(tabs)) out.openTabs = tabs.length;
  return out;
}

/** The vault counted, from a listing: how many notes, other files and folders, and their total size. */
export function vaultShape(entries: ReadonlyArray<{ path: string; size?: number }>): NonNullable<Diagnostics["vault"]> {
  const folders = new Set<string>();
  let notes = 0;
  let bytes = 0;
  for (const e of entries) {
    if (/\.(md|markdown)$/i.test(e.path)) notes++;
    bytes += e.size ?? 0;
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return { notes, otherFiles: entries.length - notes, folders: folders.size, bytes };
}

/** Assemble the bundle. All inputs are passed in, so a test can check what goes out. */
export function buildDiagnostics(input: {
  state: Record<string, unknown>;
  env: { shell: string; platform: string; language: string; userAgent: string };
  entries: ReadonlyArray<{ path: string; size?: number }> | null;
  storage: Diagnostics["storage"];
  logs?: ReturnType<typeof recentLogs>;
  now?: Date;
}): Diagnostics {
  const d: Diagnostics = {
    kind: "lumen-diagnostics",
    version: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    app: { version: appVersion, ...input.env, userAgent: scrubSecrets(input.env.userAgent) },
    settings: settingsOf(input.state),
    vault: input.entries ? vaultShape(input.entries) : null,
    storage: input.storage,
    logs: (input.logs ?? recentLogs()).map((l) => ({ t: new Date(l.t).toISOString(), level: l.level, message: scrubSecrets(l.message) })),
  };
  assertClean(d, input.state);
  return d;
}

/**
 * The last check before the bundle is shown: none of the state's free text
 * (note content and names, tab names, keys, room names) appears in it.
 * Throws rather than hand out a bundle that leaks.
 */
export function assertClean(d: Diagnostics, state: Record<string, unknown>): void {
  const json = JSON.stringify(d);
  const needles: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 5) return;
    if (typeof v === "string") {
      if (v.length >= 6 && !/^[\w .:-]{1,40}$/.test(v)) needles.push(v.length > 64 ? v.slice(0, 64) : v);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  visit(state, 0);
  for (const n of needles) if (json.includes(n)) throw new Error("the diagnostics bundle would contain text from the app's state");
}

/** The bundle as the user saves or copies it. */
export const diagnosticsText = (d: Diagnostics) => `${JSON.stringify(d, null, 2)}\n`;

/** Collect from the running app (store, vault listing, storage estimate). */
export async function collectDiagnostics(): Promise<Diagnostics> {
  const { useAppStore } = await import("../store/useStore");
  const ws = await import("../storage/workspace");
  let entries: Array<{ path: string; size?: number }> | null = null;
  try {
    entries = ws.isOPFSAvailable() ? await ws.listWorkspace({ includeAssets: true }) : null;
  } catch {
    entries = null;
  }
  let quotaMB: number | null = null;
  let usageMB: number | null = null;
  let persisted: boolean | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) {
      quotaMB = est.quota ? Math.round(est.quota / 1048576) : null;
      usageMB = est.usage ? Math.round(est.usage / 1048576) : null;
    }
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    /* unknown */
  }
  const desktop = "__TAURI_INTERNALS__" in window;
  const installed = !desktop && !!window.matchMedia?.("(display-mode: standalone)").matches;
  return buildDiagnostics({
    state: useAppStore.getState() as unknown as Record<string, unknown>,
    env: { shell: desktop ? "desktop" : installed ? "installed web app" : "web", platform: navigator.platform || "unknown", language: navigator.language || "unknown", userAgent: navigator.userAgent },
    entries,
    storage: { opfs: ws.isOPFSAvailable(), persisted, quotaMB, usageMB },
  });
}
