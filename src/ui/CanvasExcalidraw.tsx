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

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./CanvasExcalidraw.css";
import "../canvas/NoteCard.css";
import "../canvas/strings";
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
import { CARD_HEIGHT, CARD_WIDTH, NOTE_LINK, cardPositions, noteLink, notePathOf, pastedNoteRefs, resolveNoteRef } from "../canvas/noteCards";
import { NoteCard, readNote } from "../canvas/NoteCard";
import { listWorkspace } from "../storage/workspace";
import type { ExportKind } from "./canvasExport";
// The Mermaid → diagram dialog loads when it opens (its own strings and the converter come with it).
const DiagramDialog = lazy(() => import("../canvas/DiagramDialog").then((m) => ({ default: m.DiagramDialog })));
import "./canvasExcalidrawStrings";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";

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

/** What the canvas uses of Excalidraw's imperative API. */
interface CanvasApi {
  getSceneElements(): readonly SceneElement[];
  getAppState(): { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number } };
  updateScene(scene: { elements: readonly SceneElement[] }): void;
  addFiles(files: unknown[]): void;
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
  const apiRef = useRef<CanvasApi | null>(null);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [diagramOpen, setDiagramOpen] = useState(false);

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
        showAiToast(t("canvas.openFailed", { name: canvasName, error: explainError(err) }), "error");
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
        showAiToast(t("canvas.saveFailed", { name, error: explainError(err) }), "error");
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
          showAiToast(t("canvas.saveFailed", { name: trimmed, error: explainError(err) }), "error");
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
        const result = kind === "tldr" ? tldrCanvasToExcalidraw(text) : kind === "json" ? jsonCanvasToExcalidraw(text, { noteCards: true }) : legacyCanvasToExcalidraw(text);
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
        showAiToast(t("canvas.legacy.convertFailed", { error: explainError(err) }), "error");
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
        const result = jsonCanvasToExcalidraw(await file.text(), { noteCards: true });
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
        showAiToast(t("canvas.jsonCanvas.failed", { error: explainError(err) }), "error");
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
      showAiToast(t("canvas.saveFailed", { name: `${scene.name}${JSON_CANVAS_EXT}`, error: explainError(err) }), "error");
    }
  }, [store, scene]);

  /** Place cards for vault notes at the middle of the view (in a row when several). */
  const placeCards = useCallback((paths: string[]) => {
    const api = apiRef.current;
    if (!api || !paths.length) return;
    const st = api.getAppState();
    const z = st.zoom.value || 1;
    const centre = { x: -st.scrollX + st.width / 2 / z - CARD_WIDTH / 2, y: -st.scrollY + st.height / 2 / z - CARD_HEIGHT / 2 };
    const skeletons = cardPositions(paths.length, centre).map((at, i) => ({ type: "embeddable", ...at, width: CARD_WIDTH, height: CARD_HEIGHT, link: noteLink(paths[i]), roughness: 0, strokeWidth: 1, roundness: { type: 3 } }));
    const cards = convertToExcalidrawElements(skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]) as unknown as SceneElement[];
    api.updateScene({ elements: [...api.getSceneElements(), ...cards] });
  }, []);

  /** `![[note]]` / a note name → the vault note, or a toast when there's none. */
  const resolveRefs = useCallback(async (refs: string[]): Promise<string[]> => {
    const notes = (await listWorkspace().catch(() => [])).map((e) => e.path).filter((p) => /\.(md|markdown)$/i.test(p));
    const found: string[] = [];
    for (const ref of refs) {
      const p = resolveNoteRef(ref, notes);
      if (p) found.push(p);
      else showAiToast(t("canvas.card.notFound", { ref }), "error");
    }
    return found;
  }, []);

  const handleAddCard = useCallback(async () => {
    const ref = await uiPrompt({ message: t("canvas.card.prompt"), placeholder: "![[…]]" });
    if (!ref?.trim()) return;
    placeCards(await resolveRefs([ref]));
  }, [placeCards, resolveRefs]);

  const openNote = useCallback(
    async (path: string) => {
      const content = await readNote(path);
      if (content === null) {
        showAiToast(t("canvas.card.missing", { path }), "error");
        return;
      }
      saverRef.current?.flush();
      onClose();
      useAppStore.getState().openTab({ name: path.split("/").pop() ?? path, content, workspaceName: path });
    },
    [onClose],
  );

  /** Mermaid → editable elements in the middle of the view (plan W2.18). */
  const insertDiagram = useCallback(async (code: string): Promise<{ missing: string[]; editable: boolean } | { error: string }> => {
    const api = apiRef.current;
    if (!api) return { error: "the canvas isn't ready" };
    try {
      const { mermaidToElements, centredOn } = await import("./mermaidToCanvas");
      const res = await mermaidToElements(code);
      const st = api.getAppState();
      const z = st.zoom.value || 1;
      const placed = centredOn(res.elements as unknown as Array<SceneElement & { x: number; y: number; width: number; height: number }>, { x: -st.scrollX + st.width / 2 / z, y: -st.scrollY + st.height / 2 / z });
      const files = Object.values(res.files);
      if (files.length) api.addFiles(files);
      api.updateScene({ elements: [...api.getSceneElements(), ...placed] });
      if (!res.editable) showAiToast(t("canvas.diagram.insertedAsImage"), "info");
      return { missing: res.missing, editable: res.editable };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }, []);

  /** The canvas's frames as slides, in arrow order (plan W2.17). */
  const handlePresent = useCallback(async () => {
    if (!scene) return;
    const cur = latest.current;
    const sceneNow = cur ?? { elements: (scene.file?.elements ?? []) as unknown as SceneElement[], appState: (scene.file?.appState ?? {}) as SceneAppState, files: scene.file?.files ?? {} };
    try {
      const { presentCanvas } = await import("../slides/present");
      const n = await presentCanvas(sceneNow as never, scene.name, readNote);
      if (n === 0) showAiToast(t("canvas.present.noFrames"), "info");
    } catch (err) {
      log.warn("canvas presentation failed", err);
      showAiToast(t("canvas.present.failed", { error: explainError(err) }), "error");
    }
  }, [scene]);

  /** PNG / SVG / PDF with note cards drawn and Hebrew kept (src/canvas/canvasExport.ts). */
  const handleImageExport = useCallback(
    async (kind: ExportKind) => {
      if (!scene) return;
      const cur = latest.current;
      const sceneNow = cur ?? { elements: (scene.file?.elements ?? []) as unknown as SceneElement[], appState: (scene.file?.appState ?? {}) as SceneAppState, files: scene.file?.files ?? {} };
      setExporting(kind);
      try {
        const { exportCanvas, download, printSvgAsPdf } = await import("./canvasExport");
        const res = await exportCanvas(kind === "pdf" ? "svg" : kind, sceneNow, scene.name, readNote);
        if (kind === "pdf" && res.svg) await printSvgAsPdf(res.svg, scene.name);
        else download(res);
      } catch (err) {
        log.warn("canvas export failed", err);
        showAiToast(t("canvas.export.failed", { error: explainError(err) }), "error");
      } finally {
        setExporting(null);
      }
    },
    [scene],
  );

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
        <HelpButton topic="workspace/canvas" />
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
        {store && (
          <button type="button" onClick={() => void handleAddCard()} disabled={!scene} className="lumen-canvas-btn" data-testid="canvas-add-card">
            + {t("canvas.card.add")}
          </button>
        )}
        <button type="button" onClick={() => setDiagramOpen(true)} disabled={!scene} className="lumen-canvas-btn" data-testid="canvas-diagram">
          {t("canvas.diagram.open")}
        </button>
        <button type="button" onClick={() => void handlePresent()} disabled={!scene} className="lumen-canvas-btn" data-testid="canvas-present">
          ▶ {t("canvas.present")}
        </button>
        <span className="lumen-canvas-export" role="group" aria-label={t("canvas.export.label")}>
          {(["png", "svg", "pdf"] as const).map((k) => (
            <button key={k} type="button" onClick={() => void handleImageExport(k)} disabled={!scene || exporting !== null} className="lumen-canvas-btn" data-testid={`canvas-export-${k}`}>
              {exporting === k ? t("canvas.export.working") : k.toUpperCase()}
            </button>
          ))}
        </span>
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
            excalidrawAPI={(api: unknown) => {
              apiRef.current = api as CanvasApi;
            }}
            // Note cards (plan W1.16): lumen-note: embeds are ours, drawn by NoteCard; other embeds keep Excalidraw's rules.
            validateEmbeddable={(link: string) => (link.startsWith(NOTE_LINK) ? true : undefined)}
            renderEmbeddable={(el: { id: string; type: string; link: string | null }, appState: { activeEmbeddable: { element: { id: string }; state: string } | null }) => {
              const path = notePathOf(el);
              if (!path) return null;
              const active = appState.activeEmbeddable?.element.id === el.id && appState.activeEmbeddable.state === "active";
              return <NoteCard path={path} active={active} onOpen={(p) => void openNote(p)} />;
            }}
            onPaste={(data: { text?: string }) => {
              const refs = data.text ? pastedNoteRefs(data.text) : null;
              if (!refs) return true;
              void resolveRefs(refs).then(placeCards);
              return false;
            }}
            // Image export goes through the bar's PNG / SVG / PDF (Hebrew fixed, note cards drawn).
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: false, export: { saveFileToDisk: true } } }}
          />
        )}
        {diagramOpen && (
          <Suspense fallback={null}>
            <DiagramDialog onInsert={insertDiagram} onClose={() => setDiagramOpen(false)} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
