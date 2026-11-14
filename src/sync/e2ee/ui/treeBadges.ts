/**
 * Sync badges in the file tree (plan W1.8): a small mark after each file and
 * folder name — synced, pending, conflict, error, excluded. Drawn with one
 * stylesheet from the lazy sync chunk, keyed on the tree rows' `data-path`,
 * so the file tree (startup code) knows nothing about sync.
 *
 * While the vault is unlocked, every row gets the synced mark by default and
 * only the rows in another state get a rule of their own: a vault of 10,000
 * synced notes costs one rule, not 10,000. The marks carry alternative text
 * (`content: "…" / "…"`) for screen readers; the panel has the details.
 */

import { t } from "../../../i18n";
import "../strings";
import type { FileStatus, FileSyncState } from "../status";

const STYLE_ID = "lumen-sync-badges";
const ATTR = "lumenSync";

const GLYPH: Record<FileSyncState, string> = { synced: "✓", pending: "↻", conflict: "!", error: "×", excluded: "–" };
const COLOR: Record<FileSyncState, string> = {
  synced: "hsl(var(--fg-muted) / 0.7)",
  pending: "hsl(var(--info))",
  conflict: "hsl(var(--warning))",
  error: "hsl(var(--danger))",
  excluded: "hsl(var(--fg-muted) / 0.6)",
};

/** A CSS string literal: quotes, backslashes and line breaks escaped. */
export function cssString(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

function rule(selector: string, st: FileSyncState): string {
  const glyph = cssString(GLYPH[st]);
  const alt = cssString(t(`e2ee.state.${st}`));
  // The first `content` is for browsers without alternative text in `content`.
  return `${selector}::after{content:${glyph};content:${glyph} / ${alt};color:${COLOR[st]};margin-inline-start:4px;font-size:10px;line-height:1;flex-shrink:0}`;
}

/** The stylesheet for these states (exported for tests). */
export function badgeCss(files: ReadonlyMap<string, FileStatus>, folders: ReadonlyMap<string, FileSyncState>): string {
  const parts = [rule(`body[data-lumen-sync="on"] .file-tree-item[data-path]`, "synced")];
  const sel = (p: string) => `body[data-lumen-sync="on"] .file-tree-item[data-path=${cssString(p)}]`;
  for (const [p, st] of folders) if (st !== "synced") parts.push(rule(sel(p), st));
  for (const [p, st] of files) if (st.state !== "synced") parts.push(rule(sel(p), st.state));
  return parts.join("\n");
}

/** Show these states in the tree. */
export function applyTreeBadges(files: ReadonlyMap<string, FileStatus>, folders: ReadonlyMap<string, FileSyncState>): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = badgeCss(files, folders);
  document.body.dataset[ATTR] = "on";
}

/** Locked or disconnected: no marks (the tree can't know). */
export function clearTreeBadges(): void {
  if (typeof document === "undefined") return;
  document.getElementById(STYLE_ID)?.remove();
  delete document.body.dataset[ATTR];
}
