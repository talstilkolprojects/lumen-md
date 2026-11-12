/**
 * The canvas, on Excalidraw (plan 4.19, part 2; Tal's decision 15.10 (5)).
 * Replaces `CanvasTldraw.tsx`. Each canvas is `canvases/<name>.excalidraw`
 * in the vault's OPFS directory — Excalidraw's own open JSON, so the file
 * also opens in excalidraw.com — read and written through
 * `src/canvas/excalidrawFile.ts`.
 *
 * Nothing leaves the device: Excalidraw's fonts are served from this origin
 * (`public/excalidraw/fonts`, staged by scripts/copy-excalidraw.mjs, pointed
 * at by `EXCALIDRAW_ASSET_PATH`), its locale files are bundled, and the AI,
 * collaboration and share features are off.
 *
 * Hebrew: Excalidraw's hand-drawn fonts have no Hebrew glyphs, so
 * CanvasExcalidraw.css adds the Hebrew range of Assistant (shipped with
 * Excalidraw) to every canvas font family; mixed text keeps both.
 *
 * Saving: the editor reports every change; a change to the drawing itself
 * (not a selection or a pan) is written 500 ms later, and the last one when
 * the canvas closes or another one is opened.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./CanvasExcalidraw.css";
import { uiPrompt } from "./PromptDialog";
import { showAiToast } from "./AiToast";
import { useAppStore } from "../store/useStore";
import { applyLocale, getLocale, t } from "../i18n";
import { log } from "../lib/logger";
import {
  CanvasFileExistsError,
  EXCALIDRAW_EXT,
  TLDRAW_EXT,
  createExcalidrawCanvas,
  isValidCanvasName,
  listExcalidrawCanvases,
  listTldrawCanvases,
  opfsCanvasStore,
  readExcalidrawCanvas,
  writeExcalidrawCanvas,
  type CanvasStore,
} from "../canvas/excalidrawFile";
import { emptyScene, excalidrawLangOf, fileToInitialData, legacyCanvasToExcalidraw, sceneStamp, sceneToFile, tldrCanvasToExcalidraw, type SceneAppState, type SceneElement } from "../canvas/excalidrawScene";
import type { ExBinaryFile, ExcalidrawFile } from "../canvas/tldrawToExcalidraw";
import { JSON_CANVAS_EXT, excalidrawToJsonCanvas, jsonCanvasToExcalidraw, serializeJsonCanvas } from "../canvas/jsonCanvas";

// Fonts (and anything else Excalidraw fetches by relative path) come from
// this origin. Without it Excalidraw falls back to esm.sh.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
if (typeof window !== "undefined") window.EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/excalidraw/`;

interface Props {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_CANVAS_NAME = "untitled";
const LEGACY_EXT = ".canvas.json";

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

type Lists = { saved: string[]; tldr: string[]; legacy: string[]; json: string[] };

/** The canvases in the directory, by kind (`.canvas` = JSON Canvas, e.g. from an Obsidian vault; plan 4.17). */
async function listAll(store: CanvasStore): Promise<Lists> {
  const [saved, tldr, names] = await Promise.all([listExcalidrawCanvases(store), listTldrawCanvases(store), store.list()]);
  const have = new Set(saved);
  const withExt = (ext: string) => names.filter((n) => n.endsWith(ext)).map((n) => n.slice(0, -ext.length)).filter((n) => !have.has(n));
  return { saved, tldr: tldr.filter((n) => !have.has(n)), legacy: withExt(LEGACY_EXT), json: withExt(JSON_CANVAS_EXT) };
}

/** A canvas name from an imported file's name. */
function nameFromFile(fileName: string): string {
  return fileName.replace(/\.(canvas|json)$/i, "").trim().replace(/[/\\]/g, "-") || DEFAULT_CANVAS_NAME;
}

/** Is the app dark right now? (The store's "system" follows the OS.) */
function isDark(theme: string): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

export function CanvasExcalidraw({ open, onClose }: Props) {
  const theme = useAppStore((s) => s.theme);
  const locale = useAppStore((s) => s.locale);
  const store = useMemo(() => opfsCanvasStore(), []);
  const [canvasName, setCanvasName] = useState<string>(DEFAULT_CANVAS_NAME);
  const [lists, setLists] = useState<Lists>({ saved: [], tldr: [], legacy: [], json: [] });
  const importInput = useRef<HTMLInputElement>(null);
  const [scene, setScene] = useState<{ name: string; file: ExcalidrawFile | null } | null>(null);
  const [converting, setConverting] = useState<string | null>(null);
  const latest = useRef<{ elements: readonly SceneElement[]; appState: SceneAppState; files: Record<string, ExBinaryFile> } | null>(null);
  const savedStamp = useRef<string>("");
  const saverRef = useRef<{ schedule(): void; flush(): void } | null>(null);

  const refreshLists = useCallback(async () => {
    if (!store) return;
    setLists(await listAll(store));
  }, [store]);

  useEffect(() => {
    if (!open) return;
    void refreshLists();
  }, [open, refreshLists]);

  // Excalidraw sets <html lang dir> for its language: put the app's back when the canvas closes.
  useEffect(() => () => applyLocale(getLocale()), []);

  // The canvas's file, before the editor mounts for it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setScene(null);
    const load = async () => {
      const file = store ? await readExcalidrawCanvas(store, canvasName).catch((err) => {
        log.warn("excalidraw read failed", err);
        showAiToast(t("canvas.openFailed", { name: canvasName, error: (err as Error).message }), "error");
        return null;
      }) : null;
      if (cancelled) return;
      savedStamp.current = file ? sceneStamp(file.elements as unknown as SceneElement[], file.appState) : "";
      latest.current = null;
      setScene({ name: canvasName, file });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, store, canvasName]);

  // Save: the drawing's changes, debounced; the last one when this canvas goes away.
  useEffect(() => {
    if (!scene || !store) return;
    const name = scene.name;
    const saver = debouncedSave(() => {
      const cur = latest.current;
      if (!cur) return;
      const stamp = sceneStamp(cur.elements, cur.appState);
      if (stamp === savedStamp.current) return;
      savedStamp.current = stamp;
      void writeExcalidrawCanvas(store, name, sceneToFile(cur.elements, cur.appState, cur.files)).catch((err) => {
        log.warn("excalidraw save failed", err);
        showAiToast(t("canvas.saveFailed", { name, error: (err as Error).message }), "error");
      });
    }, 500);
    saverRef.current = saver;
    return () => {
      saverRef.current = null;
      saver.flush();
    };
  }, [scene, store]);

  const onChange = useCallback((elements: readonly SceneElement[], appState: SceneAppState, files: Record<string, ExBinaryFile>) => {
    latest.current = { elements, appState, files };
    if (sceneStamp(elements, appState) !== savedStamp.current) saverRef.current?.schedule();
  }, []);

  const handleNew = useCallback(async () => {
    const name = await uiPrompt({ message: t("canvas.new.prompt"), defaultValue: `canvas-${Date.now().toString(36)}` });
    if (!name) return;
    const trimmed = name.trim().replace(/[/\\]/g, "-");
    if (!isValidCanvasName(trimmed)) return;
    if (store) {
      try {
        await createExcalidrawCanvas(store, trimmed, emptyScene());
      } catch (err) {
        // Already there: open it rather than replace it.
        if (!(err instanceof CanvasFileExistsError)) {
          showAiToast(t("canvas.saveFailed", { name: trimmed, error: (err as Error).message }), "error");
          return;
        }
      }
      await refreshLists();
    }
    setCanvasName(trimmed);
  }, [store, refreshLists]);

  /** A `.tldr`, `.canvas.json` or JSON Canvas `.canvas` → `<name>.excalidraw` (the old file stays as the backup). */
  const handleConvert = useCallback(
    async (name: string, kind: "tldr" | "legacy" | "json") => {
      if (!store) return;
      setConverting(name);
      try {
        const text = await store.read(`${name}${kind === "tldr" ? TLDRAW_EXT : kind === "json" ? JSON_CANVAS_EXT : LEGACY_EXT}`);
        if (text === null) throw new Error("file not found");
        const result = kind === "tldr" ? tldrCanvasToExcalidraw(text) : kind === "json" ? jsonCanvasToExcalidraw(text) : legacyCanvasToExcalidraw(text);
        await createExcalidrawCanvas(store, name, result.file);
        await refreshLists();
        setCanvasName(name);
        showAiToast(t("canvas.legacy.converted", { name, count: String(result.file.elements.length) }), "success");
        if (result.warnings.length) log.warn("canvas conversion warnings", result.warnings);
      } catch (err) {
        if (err instanceof CanvasFileExistsError) {
          await refreshLists();
          setCanvasName(name);
          return;
        }
        log.error("canvas convert failed", err);
        showAiToast(t("canvas.legacy.convertFailed", { error: (err as Error).message }), "error");
      } finally {
        setConverting(null);
      }
    },
    [store, refreshLists],
  );

  /** A JSON Canvas file from disk (an Obsidian `.canvas`) → a new canvas, opened. */
  const handleImport = useCallback(
    async (file: File) => {
      if (!store) return;
      try {
        const result = jsonCanvasToExcalidraw(await file.text());
        const base = nameFromFile(file.name);
        let name = base;
        for (let n = 2; ; n++) {
          try {
            await createExcalidrawCanvas(store, name, result.file);
            break;
          } catch (err) {
            if (!(err instanceof CanvasFileExistsError) || n > 99) throw err;
            name = `${base}-${n}`;
          }
        }
        await refreshLists();
        setCanvasName(name);
        const nodes = result.file.elements.filter((e) => !(e.type === "text" && e.containerId)).length;
        showAiToast(t("canvas.jsonCanvas.imported", { name, count: String(nodes) }), "success");
        if (result.warnings.length) log.warn("JSON Canvas import warnings", result.warnings);
      } catch (err) {
        showAiToast(t("canvas.jsonCanvas.failed", { error: (err as Error).message }), "error");
      }
    },
    [store, refreshLists],
  );

  /** The open canvas → `<name>.canvas` next to it in the vault (for Obsidian and other JSON Canvas apps). */
  const handleExport = useCallback(async () => {
    if (!store || !scene) return;
    const cur = latest.current;
    const file = cur ? sceneToFile(cur.elements, cur.appState, cur.files) : (scene.file ?? emptyScene());
    const { canvas, warnings } = excalidrawToJsonCanvas(file);
    try {
      await store.write(`${scene.name}${JSON_CANVAS_EXT}`, serializeJsonCanvas(canvas));
      showAiToast(t("canvas.jsonCanvas.exported", { name: scene.name, nodes: String(canvas.nodes.length), edges: String(canvas.edges.length) }), "success");
      if (warnings.length) showAiToast(t("canvas.jsonCanvas.skipped", { count: String(warnings.length) }), "info");
    } catch (err) {
      showAiToast(t("canvas.saveFailed", { name: `${scene.name}${JSON_CANVAS_EXT}`, error: (err as Error).message }), "error");
    }
  }, [store, scene]);

  if (!open) return null;
  const pending = [
    ...lists.tldr.map((n) => ({ name: n, kind: "tldr" as const })),
    ...lists.legacy.map((n) => ({ name: n, kind: "legacy" as const })),
    ...lists.json.map((n) => ({ name: n, kind: "json" as const })),
  ];

  return (
    <div role="dialog" aria-modal="true" aria-label={t("canvas.dialogLabel")} className="lumen-canvas" data-testid="canvas">
      <div className="lumen-canvas-head">
        <strong style={{ fontSize: 13 }}>{t("canvas.title")}</strong>
        <select value={canvasName} onChange={(e) => setCanvasName(e.target.value)} aria-label={t("canvas.picker")} className="lumen-canvas-pick">
          {!lists.saved.includes(canvasName) && <option value={canvasName}>{canvasName}</option>}
          {lists.saved.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void handleNew()} className="lumen-canvas-btn accent">
          + {t("canvas.new")}
        </button>
        {pending.length > 0 && (
          <details className="lumen-canvas-legacy">
            <summary>{t("canvas.legacy.found", { count: String(pending.length) })}</summary>
            <div className="lumen-canvas-legacy-menu">
              {pending.map((p) => (
                <button key={`${p.kind}:${p.name}`} type="button" onClick={() => void handleConvert(p.name, p.kind)} disabled={converting === p.name}>
                  {converting === p.name ? t("canvas.legacy.converting", { name: p.name }) : t("canvas.legacy.convert", { name: p.name })}
                </button>
              ))}
            </div>
          </details>
        )}
        {store && (
          <>
            <button type="button" onClick={() => importInput.current?.click()} className="lumen-canvas-btn" data-testid="canvas-import-json">
              {t("canvas.jsonCanvas.import")}
            </button>
            <input
              ref={importInput}
              type="file"
              accept=".canvas,application/json"
              hidden
              data-testid="canvas-import-json-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleImport(f);
              }}
            />
            <button type="button" onClick={() => void handleExport()} disabled={!scene} className="lumen-canvas-btn" data-testid="canvas-export-json">
              {t("canvas.jsonCanvas.export")}
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span className="lumen-canvas-note">{store ? t("canvas.autoSaved") : t("doc.alert.workspaceUnavailable")}</span>
        <button type="button" onClick={onClose} aria-label={t("canvas.close")} className="lumen-canvas-btn">
          {t("canvas.close")}
        </button>
      </div>

      <div className="lumen-canvas-body" data-canvas-name={scene?.name ?? ""} data-file={scene ? `${scene.name}${EXCALIDRAW_EXT}` : ""}>
        {scene && (
          <Excalidraw
            key={scene.name}
            initialData={fileToInitialData(scene.file) as unknown as Parameters<typeof Excalidraw>[0]["initialData"]}
            onChange={onChange as unknown as Parameters<typeof Excalidraw>[0]["onChange"]}
            theme={isDark(theme) ? "dark" : "light"}
            langCode={excalidrawLangOf(locale)}
            aiEnabled={false}
            // Focus the canvas when it opens: Excalidraw takes its shortcuts
            // (T for text, R for rectangle…) only while focus is inside it, and
            // opening from the palette left focus outside (e2e canvas-excalidraw).
            autoFocus
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: { saveFileToDisk: true } } }}
          />
        )}
      </div>
    </div>
  );
}
