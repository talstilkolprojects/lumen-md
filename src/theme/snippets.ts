/**
 * CSS snippets from the vault (plan W1.21): `.css` files in
 * `.lumen/snippets/` (and `.obsidian/snippets/`, for a vault that came from
 * Obsidian), each switched on or off in the theme settings.
 *
 * A snippet is sanitized (./cssSanitizer.ts) before it touches the page —
 * no `@import`, no `url()` to anywhere but `data:` — and goes into its own
 * `<style>` after the app's styles. A resource-timing watch records any
 * request a stylesheet still makes in the privacy ledger.
 */

import { recordStyleRequest } from "../ai/privacyLedger";
import { log } from "../lib/logger";
import { listWorkspace, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { sanitizeCss, type SanitizeResult } from "./cssSanitizer";

export const SNIPPET_DIRS = [".lumen/snippets", ".obsidian/snippets"] as const;
const STYLE_ATTR = "data-lumen-snippet";

export interface SnippetInfo {
  /** Workspace path, e.g. `.lumen/snippets/wide.css`. */
  path: string;
  /** The file name without `.css` — what the settings show and store. */
  name: string;
}

export interface LoadedSnippet extends SnippetInfo {
  result: SanitizeResult;
}

/** Every snippet in the vault, by name (a `.lumen` one wins over an `.obsidian` one of the same name). */
export async function listSnippets(): Promise<SnippetInfo[]> {
  let entries: Awaited<ReturnType<typeof listWorkspace>> = [];
  try {
    entries = await listWorkspace({ includeHidden: true });
  } catch {
    return [];
  }
  const byName = new Map<string, SnippetInfo>();
  for (const dir of SNIPPET_DIRS) {
    for (const e of entries) {
      if (!e.path.startsWith(`${dir}/`) || !/\.css$/i.test(e.path)) continue;
      const rest = e.path.slice(dir.length + 1);
      if (rest.includes("/")) continue;
      const name = rest.replace(/\.css$/i, "");
      if (!byName.has(name)) byName.set(name, { path: e.path, name });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSnippet(info: SnippetInfo): Promise<LoadedSnippet> {
  return { ...info, result: sanitizeCss(await readWorkspaceFile(info.path)) };
}

/** Put the enabled snippets on the page (sanitized), and take the others off. */
export function applySnippets(loaded: readonly LoadedSnippet[], enabled: readonly string[], doc: Document = document): void {
  const want = new Set(enabled);
  for (const el of Array.from(doc.querySelectorAll(`style[${STYLE_ATTR}]`))) {
    if (!want.has(el.getAttribute(STYLE_ATTR) ?? "")) el.remove();
  }
  for (const s of loaded) {
    if (!want.has(s.name)) continue;
    let el = doc.querySelector<HTMLStyleElement>(`style[${STYLE_ATTR}="${CSS.escape(s.name)}"]`);
    if (!el) {
      el = doc.createElement("style");
      el.setAttribute(STYLE_ATTR, s.name);
      doc.head.appendChild(el);
    }
    if (el.textContent !== s.result.css) el.textContent = s.result.css;
  }
}

/** Load the vault's snippets and apply the enabled ones. Returns what was loaded (for the settings). */
export async function refreshSnippets(enabled: readonly string[]): Promise<LoadedSnippet[]> {
  const list = await listSnippets();
  const loaded: LoadedSnippet[] = [];
  for (const info of list) {
    try {
      loaded.push(await loadSnippet(info));
    } catch (e) {
      log.warn("snippets: read failed", info.path, e);
    }
  }
  if (typeof document !== "undefined") applySnippets(loaded, enabled);
  watchStyleRequests();
  return loaded;
}

/** Create `.lumen/snippets/` with a commented example, if there is no snippet yet. */
export async function createExampleSnippet(): Promise<string> {
  const path = `${SNIPPET_DIRS[0]}/example.css`;
  await writeWorkspaceFile(
    path,
    `/* A CSS snippet: switch it on in Settings → Theme → CSS snippets.
   Use the documented tokens (hsl(var(--accent)), var(--radius-md), …).
   Snippets can't load anything from the network: @import and url() to
   anything but data: are removed. */
.cm-content { caret-color: hsl(var(--accent)); }
`,
  );
  return path;
}

let watching = false;

/** Record in the privacy ledger any request a stylesheet makes to another origin (it should never happen). */
export function watchStyleRequests(): void {
  if (watching || typeof PerformanceObserver === "undefined" || typeof location === "undefined") return;
  watching = true;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if (e.initiatorType !== "css") continue;
        let origin = "";
        try {
          origin = new URL(e.name).origin;
        } catch {
          continue;
        }
        if (origin !== location.origin && !e.name.startsWith("data:")) recordStyleRequest(e.name);
      }
    });
    obs.observe({ type: "resource", buffered: false });
  } catch {
    watching = false;
  }
}
