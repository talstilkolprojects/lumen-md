/**
 * Live canvas (plan W6.48): two people edit one Excalidraw canvas at once,
 * through the note's collab session.
 *
 * The scene lives in the session's Yjs document, in a map per canvas
 * (`canvas:<name>`, element id → the element as Excalidraw writes it). The
 * document is the one the collab transport already syncs: in a password room
 * that is the end-to-end encrypted transport (`collab/e2e.ts`), and on the
 * public server the room token needs the room proof derived from the share
 * link's password (#469). The canvas adds no transport of its own, so it gets
 * both for free and nothing about it reaches a server in the clear.
 *
 * Merging is Excalidraw's own rule (`data/reconcile.ts` in Excalidraw, used by
 * excalidraw.com's collaboration): each element carries `version` (bumped
 * on every change) and `versionNonce` (random per change); the higher version
 * wins, a tie goes to the lower nonce. Every peer applies the same rule, so all
 * of them end on the same scene whatever order the updates come in. Deleted
 * elements are kept as tombstones (`isDeleted`), as Excalidraw does, so a
 * delete is a change like any other. The element someone is dragging or
 * typing in stays theirs until they let go.
 *
 * Presence: the pointer goes into the session's awareness (`canvas` field), and
 * other people's pointers come back as Excalidraw collaborators.
 *
 * Pure over small interfaces (a Y.Doc-like, Excalidraw's imperative API, an
 * awareness), so it is tested with fakes (src/__tests__/liveCanvas.test.ts).
 */

/** What the binding needs of an Excalidraw element. */
export interface LiveElement {
  readonly id: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly index?: string | null;
  readonly isDeleted?: boolean;
  readonly [k: string]: unknown;
}

/** The Y.Map the scene lives in (the subset of Yjs used). */
export interface LiveMap {
  get(key: string): unknown;
  set(key: string, value: unknown): unknown;
  forEach(fn: (value: unknown, key: string) => void): void;
  readonly size: number;
  observe(fn: (event: { keysChanged: Set<string> }, tr: { origin: unknown }) => void): void;
  unobserve(fn: (event: { keysChanged: Set<string> }, tr: { origin: unknown }) => void): void;
}

export interface LiveDoc {
  getMap(name: string): unknown;
  transact(fn: () => void, origin?: unknown): void;
}

/** Excalidraw's collaborator entry (types/Collaborator), the fields used here. */
export interface LiveCollaborator {
  username?: string;
  color?: { background: string; stroke: string };
  pointer?: { x: number; y: number; tool: "pointer" | "laser" };
  button?: "up" | "down";
  isCurrentUser?: boolean;
}

export interface LiveApi {
  getSceneElements(): readonly LiveElement[];
  getAppState?(): { editingTextElement?: { id: string } | null; selectedElementsAreBeingDragged?: boolean; selectedElementIds?: Record<string, true>; resizingElement?: { id: string } | null; newElement?: { id: string } | null };
  updateScene(scene: { elements?: readonly LiveElement[]; collaborators?: Map<string, LiveCollaborator>; captureUpdate?: unknown }): void;
}

export interface LiveAwareness {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  setLocalStateField(field: string, value: unknown): void;
  on(event: "change", fn: () => void): void;
  off(event: "change", fn: () => void): void;
}

/** The origin of the binding's own writes: its observer skips them. */
export const LIVE_ORIGIN = "lumen-canvas-live";

/** The Y.Map that holds a canvas: one per canvas name. */
export const canvasMapName = (canvas: string): string => `canvas:${canvas}`;

/** True when `a` replaces `b`: Excalidraw's rule (higher version; on a tie, lower versionNonce). */
export function wins(a: LiveElement, b: LiveElement): boolean {
  return a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
}

/** Fractional index order (Excalidraw 0.18 `index`), then id; an element without an index keeps its place after those with one. */
function byIndex(a: LiveElement, b: LiveElement): number {
  const ai = a.index ?? null;
  const bi = b.index ?? null;
  if (ai !== null && bi !== null && ai !== bi) return ai < bi ? -1 : 1;
  if (ai === null && bi !== null) return 1;
  if (ai !== null && bi === null) return -1;
  return 0;
}

/**
 * The local scene with the remote elements merged in. `keepLocal` holds the
 * ids being edited here right now: those stay as they are. Returns null when
 * nothing changes (no scene update needed).
 */
export function mergeElements(local: readonly LiveElement[], remote: Iterable<LiveElement>, keepLocal: ReadonlySet<string> = new Set()): LiveElement[] | null {
  const byId = new Map(local.map((e) => [e.id, e] as const));
  let changed = false;
  for (const r of remote) {
    const l = byId.get(r.id);
    if (l && (keepLocal.has(r.id) || !wins(r, l))) continue;
    byId.set(r.id, r);
    changed = true;
  }
  if (!changed) return null;
  // Stable: the sort keeps insertion order among equal keys (local order first).
  return [...byId.values()].sort(byIndex);
}

const isElement = (v: unknown): v is LiveElement =>
  typeof v === "object" && v !== null && typeof (v as LiveElement).id === "string" && typeof (v as LiveElement).version === "number" && typeof (v as LiveElement).versionNonce === "number";

/** Ids being edited locally (text being typed, a drag, a resize, a shape being drawn). */
function editingIds(api: LiveApi): Set<string> {
  const s = api.getAppState?.();
  const ids = new Set<string>();
  if (!s) return ids;
  if (s.editingTextElement) ids.add(s.editingTextElement.id);
  if (s.resizingElement) ids.add(s.resizingElement.id);
  if (s.newElement) ids.add(s.newElement.id);
  if (s.selectedElementsAreBeingDragged && s.selectedElementIds) for (const id of Object.keys(s.selectedElementIds)) ids.add(id);
  return ids;
}

export interface LiveCanvasOptions {
  awareness?: LiveAwareness | null;
  /** Excalidraw's `CaptureUpdateAction.NEVER`: a remote change is not the local user's to undo. */
  captureNever?: unknown;
  /** Called after a remote change is drawn, with the elements it brought (latency probes, tests). */
  onRemote?: (ids: string[]) => void;
}

export interface LiveCanvas {
  /** Excalidraw's onChange: writes the elements that changed since the last call. Returns how many. */
  push(elements: readonly LiveElement[]): number;
  /** Excalidraw's onPointerUpdate. */
  pointer(p: { pointer: { x: number; y: number; tool?: "pointer" | "laser" }; button: "up" | "down" }): void;
  destroy(): void;
}

/**
 * Bind an Excalidraw API to the canvas map in `doc`. If the map is empty
 * this peer seeds it with its scene; otherwise the shared scene is merged
 * into the local one right away.
 */
export function bindLiveCanvas(doc: LiveDoc, canvas: string, api: LiveApi, opts: LiveCanvasOptions = {}): LiveCanvas {
  const map = doc.getMap(canvasMapName(canvas)) as LiveMap;
  /** id → version and nonce last written or applied: unchanged elements are skipped without reading the map. */
  const seen = new Map<string, string>();
  const stamp = (e: LiveElement) => `${e.version}:${e.versionNonce}`;
  let destroyed = false;

  const write = (els: readonly LiveElement[]) => {
    if (!els.length) return;
    doc.transact(() => {
      for (const e of els) {
        // A plain copy: Excalidraw's elements are frozen objects of its own.
        map.set(e.id, JSON.parse(JSON.stringify(e)) as LiveElement);
        seen.set(e.id, stamp(e));
      }
    }, LIVE_ORIGIN);
  };

  const push = (elements: readonly LiveElement[]): number => {
    if (destroyed) return 0;
    const out: LiveElement[] = [];
    /** The room has a newer copy than this one (it came in while this was being edited). */
    const stale: string[] = [];
    for (const e of elements) {
      if (seen.get(e.id) === stamp(e)) continue;
      const prev = map.get(e.id);
      if (isElement(prev) && !wins(e, prev)) {
        seen.set(e.id, stamp(e));
        if (prev.version !== e.version || prev.versionNonce !== e.versionNonce) stale.push(e.id);
        continue;
      }
      out.push(e);
    }
    write(out);
    if (stale.length) applyRemote(stale);
    return out.length;
  };

  function applyRemote(ids: Iterable<string>) {
    const remote: LiveElement[] = [];
    for (const id of ids) {
      const v = map.get(id);
      if (isElement(v)) remote.push(v);
    }
    if (!remote.length) return;
    const local = api.getSceneElements();
    const keep = editingIds(api);
    // Yjs settles two concurrent writes of one key by client id, not by
    // Excalidraw's rule: when the local copy should have won, write it again
    // (causally after), so every peer ends on the same element.
    const byId = new Map(local.map((e) => [e.id, e] as const));
    const rewrite: LiveElement[] = [];
    for (const r of remote) {
      const l = byId.get(r.id);
      if (l && !keep.has(r.id) && wins(l, r)) rewrite.push(l);
    }
    const merged = mergeElements(local, remote, keep);
    // What is on screen now, per id (the merged copy, or the local one that was kept).
    const remoteIds = new Set(remote.map((r) => r.id));
    for (const e of merged ?? local) if (remoteIds.has(e.id)) seen.set(e.id, stamp(e));
    if (merged) {
      api.updateScene({ elements: merged, ...(opts.captureNever !== undefined ? { captureUpdate: opts.captureNever } : {}) });
      opts.onRemote?.(remote.map((r) => r.id));
    }
    write(rewrite);
  }

  const observer = (event: { keysChanged: Set<string> }, tr: { origin: unknown }) => {
    if (destroyed || tr.origin === LIVE_ORIGIN) return;
    applyRemote(event.keysChanged);
  };

  // Join: seed an empty room, else take what the room has.
  if (map.size === 0) push(api.getSceneElements());
  else {
    const ids: string[] = [];
    map.forEach((_v, k) => ids.push(k));
    applyRemote(ids);
    push(api.getSceneElements());
  }
  map.observe(observer);

  const aw = opts.awareness ?? null;
  const onAwareness = () => {
    if (destroyed || !aw) return;
    const collaborators = new Map<string, LiveCollaborator>();
    for (const [client, state] of aw.getStates()) {
      if (client === aw.clientID) continue;
      const c = state.canvas as { name?: string; pointer?: { x: number; y: number; tool?: "pointer" | "laser" }; button?: "up" | "down" } | undefined;
      if (!c || c.name !== canvas || !c.pointer) continue;
      const user = (state.user ?? {}) as { name?: string; color?: string };
      const color = typeof user.color === "string" ? user.color : "#6965db";
      collaborators.set(String(client), { username: user.name, color: { background: color, stroke: color }, pointer: { x: c.pointer.x, y: c.pointer.y, tool: c.pointer.tool ?? "pointer" }, button: c.button ?? "up" });
    }
    api.updateScene({ collaborators });
  };
  aw?.on("change", onAwareness);

  return {
    push,
    pointer(p) {
      if (destroyed || !aw) return;
      aw.setLocalStateField("canvas", { name: canvas, pointer: { x: p.pointer.x, y: p.pointer.y, tool: p.pointer.tool ?? "pointer" }, button: p.button });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      map.unobserve(observer);
      aw?.off("change", onAwareness);
      aw?.setLocalStateField("canvas", null);
    },
  };
}
