/**
 * The Excalidraw canvas's plain parts (plan 4.19, part 2): what the editor
 * hands us on every change ↔ the `.excalidraw` file we keep, when a change
 * is worth saving, the editor's language, and the two legacy formats
 * (`.tldr`, the pre-tldraw `.canvas.json`) turned into Excalidraw scenes.
 *
 * No import of `@excalidraw/excalidraw` here: this runs in unit tests and
 * in the migration without the 2 MB editor.
 */

import type { ExBinaryFile, ExcalidrawElement, ExcalidrawFile } from "./tldrawToExcalidraw";
import { tldrawToExcalidraw, type ConversionResult } from "./tldrawToExcalidraw";

/** The file's `source`: the app, not an Excalidraw deployment. */
export const SCENE_SOURCE = "https://lumen-md.app";

/** The parts of the editor state a file keeps (the rest — selection, zoom, tool — is session state). */
export interface SceneAppState {
  viewBackgroundColor?: string;
  gridSize?: number | null;
  [key: string]: unknown;
}

/** An element as the editor reports it: Excalidraw's own shape, loosely typed here. */
export interface SceneElement {
  id: string;
  type: string;
  version?: number;
  isDeleted?: boolean;
  fileId?: string | null;
  [key: string]: unknown;
}

/** An empty scene — a new canvas, or a file that couldn't be read. */
export function emptyScene(): ExcalidrawFile {
  return { type: "excalidraw", version: 2, source: SCENE_SOURCE, elements: [], appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} };
}

/**
 * The file to save from the editor's state: live elements only, the files
 * that an image still uses, and the two appState fields that belong to the
 * drawing rather than to the session.
 */
export function sceneToFile(elements: readonly SceneElement[], appState: SceneAppState, files: Record<string, ExBinaryFile>): ExcalidrawFile {
  const live = elements.filter((e) => !e.isDeleted);
  const used = new Set(live.map((e) => e.fileId).filter((id): id is string => typeof id === "string"));
  const kept: Record<string, ExBinaryFile> = {};
  for (const id of used) if (files[id]) kept[id] = files[id];
  return {
    type: "excalidraw",
    version: 2,
    source: SCENE_SOURCE,
    elements: live as unknown as ExcalidrawElement[],
    appState: {
      viewBackgroundColor: typeof appState.viewBackgroundColor === "string" ? appState.viewBackgroundColor : "#ffffff",
      gridSize: typeof appState.gridSize === "number" ? appState.gridSize : null,
    },
    files: kept,
  };
}

/** What the editor opens with: the file's elements and files, its two appState fields, scrolled to the drawing. */
export function fileToInitialData(file: ExcalidrawFile | null): { elements: ExcalidrawElement[]; appState: SceneAppState; files: Record<string, ExBinaryFile>; scrollToContent: boolean } {
  const f = file ?? emptyScene();
  return {
    elements: f.elements,
    appState: { viewBackgroundColor: f.appState.viewBackgroundColor, gridSize: f.appState.gridSize ?? null },
    files: f.files,
    scrollToContent: f.elements.length > 0,
  };
}

/**
 * A number that changes when the drawing changes (the sum of the elements'
 * versions, as Excalidraw's `getSceneVersion`) plus the saved appState
 * fields — pointer moves, selection and zoom leave it alone, so they don't
 * write the file.
 */
export function sceneStamp(elements: readonly SceneElement[], appState: SceneAppState): string {
  let v = 0;
  for (const e of elements) v += e.version ?? 0;
  return `${elements.length}:${v}:${appState.viewBackgroundColor ?? ""}:${appState.gridSize ?? ""}`;
}

/** Excalidraw's language code for the app's locale. */
export function excalidrawLangOf(locale: string): string {
  const map: Record<string, string> = { en: "en", he: "he-IL", ar: "ar-SA", ru: "ru-RU", fr: "fr-FR", de: "de-DE", ja: "ja-JP", "zh-CN": "zh-CN" };
  return map[locale] ?? "en";
}

// ---------------------------------------------------------------------------
// Legacy formats.

/** The pre-tldraw custom canvas (`<name>.canvas.json`): nodes with a position, a size and Markdown. */
export interface LegacyCanvasJson {
  nodes?: Array<{ id: string; x: number; y: number; width: number; height: number; content?: string }>;
  edges?: unknown[];
}

/**
 * A legacy `.canvas.json` as a tldraw store snapshot — one `note` per node,
 * as `CanvasTldraw.tsx` converted it — so the tldraw → Excalidraw converter
 * handles it like any other canvas. Edges never had an equivalent.
 */
export function legacyCanvasToTldrawSnapshot(data: LegacyCanvasJson): { store: Record<string, unknown>; schema: { schemaVersion: 2 } } {
  const docId = "document:document";
  const pageId = "page:legacy";
  const records: Record<string, unknown> = {
    [docId]: { id: docId, typeName: "document", gridSize: 10, name: "" },
    [pageId]: { id: pageId, typeName: "page", name: "Legacy", index: "a1", meta: {} },
  };
  for (const n of data.nodes ?? []) {
    const sid = `shape:legacy-${n.id}`;
    records[sid] = {
      id: sid,
      typeName: "shape",
      type: "note",
      x: n.x,
      y: n.y,
      props: { color: "blue", size: "m", text: (n.content ?? "").slice(0, 240), font: "draw" },
      parentId: pageId,
      isLocked: false,
      rotation: 0,
      index: "a1",
      opacity: 1,
      meta: {},
    };
  }
  return { store: records, schema: { schemaVersion: 2 } };
}

/** A legacy `.canvas.json` text as an Excalidraw scene. */
export function legacyCanvasToExcalidraw(text: string, updated = Date.now()): ConversionResult {
  const data = JSON.parse(text) as LegacyCanvasJson;
  if (!data || typeof data !== "object" || !Array.isArray(data.nodes)) throw new Error("not a legacy canvas: no nodes");
  return tldrawToExcalidraw(legacyCanvasToTldrawSnapshot(data), { source: SCENE_SOURCE, updated });
}

/** A `.tldr` text as an Excalidraw scene. */
export function tldrCanvasToExcalidraw(text: string, updated = Date.now()): ConversionResult {
  return tldrawToExcalidraw(JSON.parse(text), { source: SCENE_SOURCE, updated });
}
