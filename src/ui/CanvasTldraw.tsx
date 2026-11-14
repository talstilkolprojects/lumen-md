/**
 * Tldraw-backed canvas — replaces the hand-rolled `CanvasWhiteboard.tsx`
 * (γ.2). Each canvas persists in the vault at `canvases/<name>.tldr` (the
 * tldraw store snapshot serialised as JSON), through the vault layer like
 * every other file.
 *
 * Why tldraw vs custom HTML5 canvas:
 *   - Production-grade infinite canvas with pan / zoom / select / draw
 *   - Built-in shapes (sticky, text, geo, arrow, frame, image)
 *   - Multi-cursor, undo, redo, keyboard shortcuts — all free
 *   - Active maintenance + accessibility audited
 *
 * Persistence: the tldraw store fires a `listen()` callback on every
 * change. We debounce 500 ms and write `getSnapshot()` to OPFS. On
 * mount we read the file and `loadSnapshot()` if present.
 */

import {
  Tldraw,
  getSnapshot,
  loadSnapshot,
  type Editor as TldrawEditor,
} from "tldraw";
import "tldraw/tldraw.css";
import { useCallback, useEffect, useState } from "react";
import { uiPrompt } from "./PromptDialog";
import { showAiToast } from "./AiToast";
import { isOPFSAvailable, listWorkspaceDir, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { t } from "../i18n";
import { log } from "../lib/logger";

interface Props {
  open: boolean;
  onClose: () => void;
}

const CANVAS_DIR = "canvases";
const DEFAULT_CANVAS_NAME = "untitled";

/** Read the tldraw blob for a canvas. Returns null when the file isn't there. */
async function loadCanvasFile(name: string): Promise<unknown | null> {
  if (!isOPFSAvailable()) return null;
  try {
    return JSON.parse(await readWorkspaceFile(`${CANVAS_DIR}/${name}.tldr`));
  } catch {
    return null;
  }
}

async function saveCanvasFile(name: string, snapshot: unknown): Promise<void> {
  if (!isOPFSAvailable()) return;
  await writeWorkspaceFile(`${CANVAS_DIR}/${name}.tldr`, JSON.stringify(snapshot));
}

/** Basenames (without `ext`) of the files in `canvases/` ending in `ext`; [] when there is no such folder. */
async function listCanvasFiles(ext: string): Promise<string[]> {
  if (!isOPFSAvailable()) return [];
  try {
    return (await listWorkspaceDir(CANVAS_DIR))
      .filter((e) => e.kind === "file" && e.name.endsWith(ext))
      .map((e) => e.name.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

async function listCanvases(): Promise<string[]> {
  return listCanvasFiles(".tldr");
}

/**
 * Find legacy `.canvas.json` files (the pre-tldraw custom format) so
 * users can convert old work without losing layout + connections.
 */
async function listLegacyCanvases(): Promise<string[]> {
  return listCanvasFiles(".canvas.json");
}

/**
 * Convert a legacy custom-canvas file to a tldraw `.tldr` snapshot.
 *
 * Legacy format: `{ nodes: [{x,y,width,height,content,color}], edges: [...] }`.
 * Each node becomes a tldraw `note` shape preserving position + content
 * preview. Conversion is lossy (markdown bodies → plain text) but the
 * layout — the expensive thing — is preserved.
 */
async function convertLegacyCanvas(
  name: string,
): Promise<{ converted: boolean; nodeCount: number }> {
  if (!isOPFSAvailable()) return { converted: false, nodeCount: 0 };
  const text = await readWorkspaceFile(`${CANVAS_DIR}/${name}.canvas.json`);
  const data = JSON.parse(text) as {
    nodes?: Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      content: string;
    }>;
  };
  const docId = "document:document";
  const pageId = "page:legacy";
  const records: Record<string, unknown> = {
    [docId]: { id: docId, typeName: "document", gridSize: 10, name: "" },
    [pageId]: {
      id: pageId,
      typeName: "page",
      name: "Legacy",
      index: "a1",
      meta: {},
    },
  };
  let nodeCount = 0;
  for (const n of data.nodes ?? []) {
    const sid = `shape:legacy-${n.id}`;
    records[sid] = {
      id: sid,
      typeName: "shape",
      type: "note",
      x: n.x,
      y: n.y,
      props: {
        color: "blue",
        size: "m",
        text: (n.content ?? "").slice(0, 240),
        font: "draw",
      },
      parentId: pageId,
      isLocked: false,
      rotation: 0,
      index: "a1",
      opacity: 1,
      meta: {},
    };
    nodeCount++;
  }
  const snapshot = { store: records, schema: { schemaVersion: 2 } };
  await writeWorkspaceFile(`${CANVAS_DIR}/${name}.tldr`, JSON.stringify(snapshot));
  return { converted: true, nodeCount };
}

// Re-export for tests.
export { convertLegacyCanvas, listLegacyCanvases };

/**
 * A debounced save that can be flushed: closing the canvas (unmount) or
 * switching to another one writes the pending change instead of dropping it.
 * @internal exported for tests.
 */
export function debouncedSave(save: () => void, ms: number): { schedule(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        save();
      }, ms);
    },
    flush() {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
      save();
    },
  };
}

export function CanvasTldraw({ open, onClose }: Props) {
  const [editor, setEditor] = useState<TldrawEditor | null>(null);
  const [canvasName, setCanvasName] = useState<string>(DEFAULT_CANVAS_NAME);
  const [savedList, setSavedList] = useState<string[]>([]);
  const [legacyList, setLegacyList] = useState<string[]>([]);
  const [converting, setConverting] = useState<string | null>(null);

  // Load the canvas list (and any legacy `.canvas.json` files) on open
  // so the picker shows everything the user has + a convert affordance.
  useEffect(() => {
    if (!open) return;
    void listCanvases().then(setSavedList);
    void listLegacyCanvases().then(setLegacyList);
  }, [open]);

  // When the editor mounts (or canvas name changes), restore from OPFS.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    void loadCanvasFile(canvasName).then((snap) => {
      if (cancelled || !editor || !snap) return;
      try {
        loadSnapshot(editor.store, snap as Parameters<typeof loadSnapshot>[1]);
      } catch (err) {
        log.warn("tldraw loadSnapshot failed", err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [editor, canvasName]);

  // Subscribe to store changes; debounced save.
  useEffect(() => {
    if (!editor) return;
    const saver = debouncedSave(() => {
      try {
        const snap = getSnapshot(editor.store);
        void saveCanvasFile(canvasName, snap).catch((err) =>
          log.warn("tldraw save failed", err),
        );
      } catch (err) {
        log.warn("tldraw getSnapshot failed", err);
      }
    }, 500);
    const off = editor.store.listen(() => saver.schedule());
    return () => {
      off();
      saver.flush(); // the last strokes before close / canvas switch
    };
  }, [editor, canvasName]);

  const handleNew = useCallback(async () => {
    const name = await uiPrompt({
      message: t("canvas.new.prompt") ?? "Canvas name:",
      defaultValue: `canvas-${Date.now().toString(36)}`,
    });
    if (!name) return;
    const trimmed = name.trim().replace(/[/\\]/g, "-");
    if (!trimmed) return;
    setCanvasName(trimmed);
    if (editor) {
      // Clear and start fresh.
      editor.selectAll();
      editor.deleteShapes(editor.getSelectedShapeIds());
    }
    setSavedList((prev) => Array.from(new Set([...prev, trimmed])).sort());
  }, [editor]);

  const handlePick = useCallback((name: string) => {
    setCanvasName(name);
  }, []);

  const handleConvertLegacy = useCallback(
    async (legacyName: string) => {
      setConverting(legacyName);
      try {
        const { nodeCount } = await convertLegacyCanvas(legacyName);
        // Refresh both lists; switch to the converted canvas.
        const [tldrs, legacies] = await Promise.all([
          listCanvases(),
          listLegacyCanvases(),
        ]);
        setSavedList(tldrs);
        setLegacyList(legacies);
        setCanvasName(legacyName);
        showAiToast(
          t("canvas.legacy.converted", { name: legacyName, count: String(nodeCount) }),
          "success",
        );
      } catch (err) {
        log.error("legacy canvas convert failed", err);
        showAiToast(
          t("canvas.legacy.convertFailed", { error: (err as Error).message }),
          "error",
        );
      } finally {
        setConverting(null);
      }
    },
    [],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("canvas.dialogLabel") ?? "Whiteboard"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        background: "hsl(var(--bg))",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 12px",
          borderBottom: "1px solid hsl(var(--border))",
          background: "hsl(var(--bg-subtle))",
        }}
      >
        <strong style={{ fontSize: 13 }}>{t("canvas.title") ?? "Canvas"}</strong>
        <select
          value={canvasName}
          onChange={(e) => handlePick(e.target.value)}
          aria-label={t("canvas.picker") ?? "Pick canvas"}
          style={{
            padding: "3px 6px",
            border: "1px solid hsl(var(--border))",
            background: "hsl(var(--bg))",
            color: "hsl(var(--fg))",
            fontSize: 12,
            borderRadius: 4,
          }}
        >
          {!savedList.includes(canvasName) && (
            <option value={canvasName}>{canvasName} (unsaved)</option>
          )}
          {savedList.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleNew}
          style={{
            padding: "3px 9px",
            fontSize: 12,
            border: "1px solid hsl(var(--accent))",
            background: "transparent",
            color: "hsl(var(--accent))",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          + {t("canvas.new") ?? "New"}
        </button>
        {legacyList.length > 0 && (
          <details
            style={{
              fontSize: 11,
              color: "hsl(var(--fg-muted))",
            }}
          >
            <summary style={{ cursor: "pointer", listStyle: "none" }}>
              {t("canvas.legacy.found", { count: String(legacyList.length) })}
            </summary>
            <div
              style={{
                position: "absolute",
                background: "hsl(var(--bg))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                padding: 8,
                marginTop: 4,
                minWidth: 220,
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                zIndex: 200,
              }}
            >
              {legacyList.map((legacy) => (
                <button
                  key={legacy}
                  type="button"
                  onClick={() => handleConvertLegacy(legacy)}
                  disabled={converting === legacy}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "start",
                    padding: "4px 8px",
                    margin: "2px 0",
                    border: "none",
                    background: "transparent",
                    color: "hsl(var(--fg))",
                    fontSize: 12,
                    cursor: "pointer",
                    borderRadius: 4,
                  }}
                >
                  {converting === legacy
                    ? t("canvas.legacy.converting", { name: legacy })
                    : t("canvas.legacy.convert", { name: legacy })}
                </button>
              ))}
            </div>
          </details>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
          {t("canvas.autoSaved")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("canvas.close") ?? "Close"}
          style={{
            padding: "3px 9px",
            fontSize: 12,
            border: "1px solid hsl(var(--border))",
            background: "transparent",
            color: "hsl(var(--fg))",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {t("canvas.close") ?? "Close"}
        </button>
      </div>

      {/* tldraw fills the rest */}
      <div style={{ flex: 1, position: "relative" }}>
        <Tldraw
          onMount={(ed) => setEditor(ed)}
          inferDarkMode
        />
      </div>
    </div>
  );
}
