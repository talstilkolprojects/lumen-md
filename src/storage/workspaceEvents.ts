/**
 * Workspace change events with detail (C3).
 *
 * Before, every autosave (every ~600 ms of typing) fired a bare
 * `lumen-workspace-changed`, and every listener redid everything: the file
 * tree re-listed the vault, the tags panel and the backlinks index re-read
 * every note. Now an event says what changed:
 *
 *   kind "content"   — these files' text changed; nothing was added,
 *                      removed or renamed (autosave)
 *   kind "structure" — files may have appeared / disappeared (default for
 *                      a bare event, so old dispatchers stay correct)
 *
 * and listeners can coalesce bursts.
 */

export const WORKSPACE_CHANGED = "lumen-workspace-changed";

export interface WorkspaceChange {
  kind: "content" | "structure";
  /** Changed paths, when known. */
  paths?: string[];
}

export function notifyWorkspaceChanged(change: WorkspaceChange = { kind: "structure" }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WorkspaceChange>(WORKSPACE_CHANGED, { detail: change }));
}

/** The change an event describes (bare events = structure, unknown paths). */
export function changeOf(e: Event): WorkspaceChange {
  const d = (e as CustomEvent<WorkspaceChange | null>).detail;
  return d && (d.kind === "content" || d.kind === "structure") ? d : { kind: "structure" };
}

/** Merge two changes: structure wins; paths union (unknown stays unknown). */
export function mergeChanges(a: WorkspaceChange | null, b: WorkspaceChange): WorkspaceChange {
  if (!a) return b;
  const kind = a.kind === "structure" || b.kind === "structure" ? "structure" : "content";
  const paths = a.paths && b.paths ? [...new Set([...a.paths, ...b.paths])] : undefined;
  return { kind, paths };
}

/**
 * Listen with coalescing: a burst of events within `debounceMs` is
 * delivered once, as the merged change. Returns the unsubscribe function.
 */
export function onWorkspaceChanged(fn: (c: WorkspaceChange) => void, opts: { debounceMs?: number } = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const wait = opts.debounceMs ?? 0;
  let pending: WorkspaceChange | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = (e: Event) => {
    const c = changeOf(e);
    if (!wait) return fn(c);
    pending = mergeChanges(pending, c);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const p = pending!;
      pending = null;
      timer = null;
      fn(p);
    }, wait);
  };
  window.addEventListener(WORKSPACE_CHANGED, handler);
  return () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener(WORKSPACE_CHANGED, handler);
  };
}
