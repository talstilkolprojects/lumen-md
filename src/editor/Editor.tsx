/**
 * CM6 AUTHORS — ViewPlugin lifecycle constraints (ADR-001):
 *   `ViewPlugin.fromClass` constructors run *inside* CodeMirror's
 *   update cycle. Calling `view.dispatch(...)` synchronously from a
 *   constructor (or from anything the constructor calls) throws
 *   "Calls to EditorView.update are not allowed while an update is
 *   in progress". Defer dispatches via `setTimeout(0)` — see
 *   src/editor/lintExtension.ts (constructor + run()) for the
 *   canonical example. Same rule applies to any code path inside
 *   `update(u: ViewUpdate)` that wants to dispatch synchronously.
 */
import { readyToReveal } from "./revealLine";
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, search } from "@codemirror/search";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bidiExtension } from "./bidi";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { StateField, StateEffect } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { chat } from "../ai/llm";
import { aiOperation } from "../ai/aiAbort";
import { PROMPTS } from "../ai/prompts";
import { embedHintExtension } from "./embedHintExtension";
import { insertSlashMenuExtension } from "./insertMenu";
import { wikiLinkAutocomplete } from "./wikiLinkAutocomplete";
import { collabAwarenessExtension } from "./collabAwareness";
import { t as i18nT, getLocale } from "../i18n";
// y-codemirror.next (and the yjs stack behind it) is loaded on demand inside
// the collab effect below — a static import dragged ~60KB gz of yjs into the
// eager boot path for a feature that's off until a session starts.
import { typewriterModeExtension } from "./typewriterMode";
import { useAppStore } from "../store/useStore";
import { markdownLintExtension } from "./lintExtension";
// commentDecorations imports yjs (comment anchors are Y.Map relative
// positions) — loaded on demand in the collab effect, like ySync below.
import { searchHighlightExtension } from "./searchHighlight";
import { showSpokenRange, speechHighlightExtension } from "./speechHighlight";
import { inlineSuggestion } from "./inlineSuggestion";
import { formatKeymap } from "./formatKeymap";
import { setSuggesting, suggestingAuthor, suggestingExtension, suggestingSkip } from "./suggestingExtension";
import { useAuth } from "../auth/useAuth";
import type { CollabSession } from "../collab/yjs";

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "tok-heading tok-heading1" },
  { tag: t.heading2, class: "tok-heading tok-heading2" },
  { tag: t.heading3, class: "tok-heading tok-heading3" },
  { tag: t.heading4, class: "tok-heading" },
  { tag: t.heading5, class: "tok-heading" },
  { tag: t.heading6, class: "tok-heading" },
  { tag: t.emphasis, class: "tok-emphasis" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.link, class: "tok-link" },
  { tag: t.url, class: "tok-link" },
  { tag: t.monospace, class: "tok-monospace" },
  { tag: t.string, class: "tok-string" },
  { tag: t.quote, class: "tok-quote" },
  { tag: t.meta, class: "tok-meta" },
  { tag: t.processingInstruction, class: "tok-meta" },
]);

interface EditorProps {
  value: string;
  onChange: (next: string) => void;
  /**
   * Called when the user pastes/drops an image. Should return a markdown URL
   * (relative path or data URL) to insert at the cursor, or null to fall back
   * to the browser's default behavior.
   */
  onAddAsset?: (file: File) => Promise<string | null>;
  /** Toggle Vim keybindings. */
  vimEnabled?: boolean;
  /** Toggle browser-native spell-check (red squiggle underlines). */
  spellCheck?: boolean;
  /** Toggle LanguageTool grammar/style checker (debounced network call). */
  grammarCheck?: boolean;
  /** Centre the active line vertically (typewriter scroll mode). */
  typewriterMode?: boolean;
  /** Active collaboration session — when set, peer cursors render live. */
  collab?: CollabSession | null;
  /** Suggesting mode (track changes): record edits as CriticMarkup. */
  suggesting?: boolean;
}

/** Automatic alt text for pasted images (T31); `lumen.ai.imageText` = "off" disables it. */
function imageTextEnabled(): boolean {
  try {
    return localStorage.getItem("lumen.ai.imageText") !== "off";
  } catch {
    return true;
  }
}

export interface EditorHandle {
  /** Insert text at the current selection and focus the editor. */
  insertText: (text: string) => void;
  focus: () => void;
  /** Return the underlying CodeMirror view (or null before mount). */
  getView: () => EditorView | null;
}

const vimCompartment = new Compartment();
const spellCheckCompartment = new Compartment();
const collabCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const tsChecksCompartment = new Compartment();
const commentsCompartment = new Compartment();
const grammarCompartment = new Compartment();

let vimExtensionPromise: Promise<unknown> | null = null;
async function loadVimExtension() {
  if (!vimExtensionPromise) {
    vimExtensionPromise = import("@replit/codemirror-vim").then((m) => m.vim());
  }
  return vimExtensionPromise;
}

let grammarExtensionPromise: Promise<typeof import("./grammarExtension")> | null = null;
async function loadGrammarExtension() {
  if (!grammarExtensionPromise) {
    grammarExtensionPromise = import("./grammarExtension");
  }
  const m = await grammarExtensionPromise;
  return m.grammarExtension;
}

/* ─── Ghost Text (Copilot-style inline completion) ─────────────── */

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.text;
    span.style.opacity = "0.4";
    span.style.fontStyle = "italic";
    span.style.pointerEvents = "none";
    span.className = "cm-ghost-text";
    return span;
  }
  eq(other: GhostWidget) { return this.text === other.text; }
}

const setGhostText = StateEffect.define<{ pos: number; text: string } | null>();

interface GhostState {
  pos: number;
  text: string;
  decorations: DecorationSet;
}

const ghostField = StateField.define<GhostState | null>({
  create() { return null; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhostText)) {
        if (!e.value) return null;
        const deco = Decoration.set([
          Decoration.widget({
            widget: new GhostWidget(e.value.text),
            side: 1,
          }).range(e.value.pos),
        ]);
        return { pos: e.value.pos, text: e.value.text, decorations: deco };
      }
    }
    // Clear ghost on any doc change or selection move
    if (value && (tr.docChanged || tr.selection)) return null;
    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f, (v) => v?.decorations ?? Decoration.none);
  },
});

function ghostTextExtension(): Extension {
  let controller: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return [
    ghostField,
    keymap.of([
      {
        // Ctrl+Space → fetch AI ghost text
        key: "Ctrl-Space",
        run(view) {
          controller?.abort();
          if (debounceTimer) clearTimeout(debounceTimer);

          const pos = view.state.selection.main.head;
          const textBefore = view.state.doc.sliceString(
            Math.max(0, pos - 500), pos,
          );
          if (!textBefore.trim()) return false;

          debounceTimer = setTimeout(async () => {
            // Explicit Ctrl-Space request: counts against the AI quota when
            // it is actually sent (ownPrompt), not before chat()'s checks.
            // T55: registered, so Esc / "AI: Cancel" stop it too.
            const op = aiOperation();
            try {
              const c = (controller = new AbortController());
              op.signal.addEventListener("abort", () => c.abort(op.signal.reason), { once: true });
              const text = await chat(
                [
                  { role: "system", content: PROMPTS.autocomplete },
                  { role: "user", content: textBefore },
                ],
                { maxTokens: 15, signal: controller.signal, ownPrompt: true, tier: "light" },
              );
              if (text && view.state.selection.main.head === pos) {
                view.dispatch({ effects: setGhostText.of({ pos, text }) });
              }
            } catch {
              // Silently ignore abort / API errors for completions
            } finally {
              op.end();
            }
          }, 150);
          return true;
        },
      },
      {
        // Tab → accept ghost text
        key: "Tab",
        run(view) {
          const ghost = view.state.field(ghostField);
          if (!ghost) return false;
          view.dispatch({
            changes: { from: ghost.pos, insert: ghost.text },
            selection: { anchor: ghost.pos + ghost.text.length },
            effects: setGhostText.of(null),
          });
          return true;
        },
      },
      {
        // Escape → dismiss ghost text
        key: "Escape",
        run(view) {
          const ghost = view.state.field(ghostField);
          if (!ghost) return false;
          view.dispatch({ effects: setGhostText.of(null) });
          return true;
        },
      },
    ]),
  ];
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  {
    value,
    onChange,
    onAddAsset,
    vimEnabled = false,
    spellCheck = true,
    grammarCheck = false,
    typewriterMode = false,
    collab = null,
    suggesting = false,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAddAssetRef = useRef(onAddAsset);
  onAddAssetRef.current = onAddAsset;
  // When the parent pushes a new value into the editor (file open),
  // we want to suppress the resulting onChange notification.
  const syncingRef = useRef(false);
  // The line gutter was removed — instead, the current cursor line is shown
  // in a small overlay pill that fades in next to the scrollbar on hover or
  // while the user is actively editing.
  const [currentLine, setCurrentLine] = useState(1);
  const [showLineBadge, setShowLineBadge] = useState(false);
  const lineBadgeHideTimer = useRef<number | null>(null);

  const flashLineBadge = () => {
    setShowLineBadge(true);
    if (lineBadgeHideTimer.current != null) {
      window.clearTimeout(lineBadgeHideTimer.current);
    }
    lineBadgeHideTimer.current = window.setTimeout(() => {
      setShowLineBadge(false);
      lineBadgeHideTimer.current = null;
    }, 1200);
  };

  useImperativeHandle(
    ref,
    () => ({
      insertText(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        view.focus();
      },
      focus() {
        viewRef.current?.focus();
      },
      getView() {
        return viewRef.current;
      },
    }),
    [],
  );

  useEffect(() => {
    if (!hostRef.current) return;

    const imageDropPasteHandlers = EditorView.domEventHandlers({
      paste(event, view) {
        const items = event.clipboardData?.items;
        if (!items) return false;
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind === "file" && it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length === 0) return false;
        event.preventDefault();
        void handleAssetFiles(view, files);
        return true;
      },
      drop(event, view) {
        const dt = event.dataTransfer;
        if (!dt?.files?.length) return false;
        const files = Array.from(dt.files).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void handleAssetFiles(view, files);
        return true;
      },
    });

    // Local storage acts as truth for the document.
    const initialDoc = value;

    const baseExtensions = [
      vimCompartment.of([]),
      embedHintExtension(),
      insertSlashMenuExtension(),
      history(),
      bracketMatching(),
      indentOnInput(),
      highlightActiveLine(),
      search({ top: true }),
      ghostTextExtension(),
      ...inlineSuggestion(),
      closeBrackets(),
      syntaxHighlighting(mdHighlight),
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        addKeymap: true,
        // No HTML-tag completion: the editor never offered it, and with the
        // completion UI now on (for `[[` links) it would pop up on every `<`.
        completeHTMLTags: false,
      }),
      // `[[` → notes, `[[Note#` → headings, `[[Note#^` → blocks (4.5); the
      // source itself loads on the first `[[`.
      wikiLinkAutocomplete(),
      EditorView.lineWrapping,
      // Hebrew and English lines each read in their own direction (T25).
      bidiExtension(),
      // Accessible name for the contenteditable (role=textbox) surface —
      // without it, screen readers announce an unnamed input (axe:
      // aria-input-field-name).
      EditorView.contentAttributes.of({ "aria-label": i18nT("editor.ariaLabel") }),
      spellCheckCompartment.of(
        EditorView.contentAttributes.of({ spellcheck: spellCheck ? "true" : "false" }),
      ),
      // Starts empty even mid-session: the collab effect below reconfigures
      // with the (lazily-imported) char-level ySync binding right after mount.
      collabCompartment.of([]),
      // Comment anchors as yellow highlights — the source of truth lives in
      // the Yjs `lumen-comments` map; the collab effect below loads the
      // extension on demand and reconfigures (starts empty, like collab).
      commentsCompartment.of([]),
      typewriterCompartment.of(typewriterMode ? typewriterModeExtension() : []),
      // TypeScript checks in ```ts blocks — opt-in; the extension (and the
      // compiler worker) is loaded only once the setting is on.
      tsChecksCompartment.of([]),
      // LanguageTool grammar / style — opt-in, debounced 1.5s. Off by
      // default because the public endpoint is rate-limited; users with a
      // self-hosted backend can flip this on with no other config change.
      // Loaded dynamically when toggled on to keep the initial bundle small.
      grammarCompartment.of([]),
      // Live markdown lint — wavy underlines for trailing whitespace,
      // mixed-indent, heading-skip, broken wiki-links. Runs every 250 ms
      // after the user stops typing.
      markdownLintExtension(),
      // Workspace search → editor: when SearchDialog opens a hit, this
      // extension flashes the matches and scrolls the first one into view.
      searchHighlightExtension(),
      speechHighlightExtension(),
      // Suggesting mode (track changes) — CriticMarkup decorations are
      // always on; the edit-rewriting filter only while the flag is set.
      suggestingExtension(suggesting),
      // New suggestions are attributed to the signed-in user (name, else the
      // part of the e-mail before @); anonymous edits stay unattributed.
      suggestingAuthor.of(() => {
        const user = useAuth.getState().user;
        return user?.name?.trim() || user?.email?.split("@")[0] || null;
      }),
      imageDropPasteHandlers,
      // Shift-Alt-F → format document (Prettier, lazy-loaded on first use).
      formatKeymap(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !syncingRef.current) {
          onChangeRef.current(u.state.doc.toString());
        }
        // Track the current line for the floating line-number badge.
        if (u.docChanged || u.selectionSet) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head).number;
          setCurrentLine(line);
          flashLineBadge();
        }
      }),
    ];

    const startState = EditorState.create({
      doc: initialDoc,
      extensions: baseExtensions,
    });

    async function handleAssetFiles(view: EditorView, files: File[]) {
      const onAsset = onAddAssetRef.current;
      const inserts: string[] = [];
      const placed: Array<{ file: File; url: string; alt: string }> = [];
      for (const f of files) {
        let url: string | null = null;
        if (onAsset) {
          try {
            url = await onAsset(f);
          } catch {
            url = null;
          }
        }
        if (!url) {
          // Fallback: inline as base64 data URL.
          url = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(f);
          });
        }
        const alt = f.name.replace(/\.[^.]+$/, "");
        inserts.push(`![${alt}](${url})`);
        placed.push({ file: f, url, alt });
      }
      const text = inserts.join("\n\n") + "\n";
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      // T31: real alt text in the background (also for data-URL fallbacks).
      if (imageTextEnabled() && placed.length) {
        void import("./pastedImageText").then((m) => m.fillPastedImageText(view, placed, getLocale())).catch(() => undefined);
      }
    }

    const view = new EditorView({ state: startState, parent: hostRef.current });
    viewRef.current = view;



    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep editor in sync if value is set externally (e.g. file open).
  // When collab is active, the Yjs binding owns the document; ignore parent
  // value updates that came from our own onChange.
  useEffect(() => {
    if (collab) return;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    syncingRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    } finally {
      syncingRef.current = false;
    }
  }, [value, collab]);

  // Toggle Vim keybindings on demand without recreating the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    (async () => {
      // `loadVimExtension` returns the dynamically-imported plugin's
      // default export — typed as `unknown` because @replit/codemirror-vim
      // ships no .d.ts. Cast through Extension here so the compartment
      // reconfigure call typechecks without a blanket `any`.
      const ext = vimEnabled
        ? ((await loadVimExtension()) as Extension)
        : [];
      if (cancelled || !viewRef.current) return;
      view.dispatch({ effects: vimCompartment.reconfigure(ext) });
    })();
    return () => {
      cancelled = true;
    };
  }, [vimEnabled]);

  // Toggle browser-native spellcheck without recreating the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: spellCheckCompartment.reconfigure(
        EditorView.contentAttributes.of({ spellcheck: spellCheck ? "true" : "false" }),
      ),
    });
  }, [spellCheck]);

  // When the user starts / stops a collab session, swap the awareness
  // extension in or out without recreating the whole editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    (async () => {
      let collabExt: Extension = [];
      let commentsExt: Extension = [];
      if (collab?.ytext) {
        // Char-level CRDT binding: edits become Yjs ops (no full-doc clobber
        // on concurrent edits), plus live remote cursors. Loaded on demand —
        // see the import note at the top of the file.
        const [{ ySync, ySyncFacet, YSyncConfig }, { commentDecorations }] =
          await Promise.all([import("y-codemirror.next"), import("./commentDecorations")]);
        const syncConf = new YSyncConfig(collab.ytext, collab.awareness);
        collabExt = [
          ySyncFacet.of(syncConf),
          ySync,
          collabAwarenessExtension(collab.awareness),
          // Remote peers' edits arrive tagged with ySync's annotation (whose
          // value is this config): never re-wrap them as our suggestions.
          suggestingSkip.of((tr) =>
            (tr as unknown as { annotations: ReadonlyArray<{ value: unknown }> }).annotations
              .some((a) => a.value === syncConf),
          ),
        ];
        if (collab.doc) commentsExt = commentDecorations({ doc: collab.doc });
      }
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: [
          collabCompartment.reconfigure(collabExt),
          commentsCompartment.reconfigure(commentsExt),
        ],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [collab]);

  // Toggle suggesting mode (track changes) without recreating the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setSuggesting.of(suggesting) });
  }, [suggesting]);

  // TypeScript checks: lazy-load the extension + worker client when enabled.
  const tsChecks = useAppStore((s) => s.tsChecks);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let ext: Extension = [];
      if (tsChecks) {
        const [{ tsCheckExtension }, { tsClient }] = await Promise.all([
          import("./tsCheckExtension"),
          import("../lsp/tsClient"),
        ]);
        ext = tsCheckExtension(tsClient);
      } else {
        const { tsClient } = await import("../lsp/tsClient");
        tsClient.dispose();
      }
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({ effects: tsChecksCompartment.reconfigure(ext) });
    })();
    return () => {
      cancelled = true;
    };
  }, [tsChecks]);

  // Toggle typewriter mode without recreating the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: typewriterCompartment.reconfigure(
        typewriterMode ? typewriterModeExtension() : [],
      ),
    });
  }, [typewriterMode]);

  // Toggle the grammar checker without recreating the editor. Mounting
  // the extension also kicks off the first check via its constructor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    (async () => {
      const ext = grammarCheck
        ? (await loadGrammarExtension())()
        : [];
      if (cancelled || !viewRef.current) return;
      view.dispatch({ effects: grammarCompartment.reconfigure(ext) });
    })();
    return () => { cancelled = true; };
  }, [grammarCheck]);

  // Mobile shortcut bar dispatches `lumen-mobile-insert` events. Listen at
  // window level so we receive them regardless of which surface dispatched.
  useEffect(() => {
    function onInsert(e: Event) {
      const view = viewRef.current;
      if (!view) return;
      const detail = (e as CustomEvent<{ insert: string; cursorOffset: number }>).detail;
      if (!detail?.insert) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: detail.insert },
        selection: { anchor: from + detail.insert.length + (detail.cursorOffset ?? 0) },
      });
      view.focus();
    }
    window.addEventListener("lumen-mobile-insert", onInsert);
    return () => window.removeEventListener("lumen-mobile-insert", onInsert);
  }, []);

  // `lumen-reveal-line` {line} (1-based): jump to and select that line —
  // used by vault citations (T29). With `content` it waits until the
  // just-opened note has actually loaded into the editor.
  useEffect(() => {
    function onReveal(e: Event) {
      const detail = (e as CustomEvent<{ line: number; content?: string }>).detail;
      const line = detail?.line;
      if (!line || line < 1) return;
      let tries = 0;
      const go = () => {
        const view = viewRef.current;
        // Wait for the opened note itself (not the previous one); after
        // ~2 s fall back to whatever is shown.
        const ready = !!view && readyToReveal(view.state.doc, line, tries < 20 ? detail.content : undefined);
        if (!view || !ready) {
          if (tries++ < 20) setTimeout(go, 100);
          return;
        }
        const l = view.state.doc.line(line);
        view.dispatch({ selection: { anchor: l.from, head: l.to }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
        view.focus();
      };
      go();
    }
    window.addEventListener("lumen-reveal-line", onReveal);
    return () => window.removeEventListener("lumen-reveal-line", onReveal);
  }, []);

  // `lumen-speech-range` {from, to} | null: highlight and show the sentence
  // being read aloud (T32) — a decoration, not the selection, so typing
  // during playback can't replace the sentence; null clears it.
  useEffect(() => {
    function onSelect(e: Event) {
      const view = viewRef.current;
      if (!view) return;
      showSpokenRange(view, (e as CustomEvent<{ from: number; to: number } | null>).detail ?? null);
    }
    window.addEventListener("lumen-speech-range", onSelect);
    return () => window.removeEventListener("lumen-speech-range", onSelect);
  }, []);

  return (
    <div
      className="flex-1 min-h-0 relative overflow-hidden"
      onMouseEnter={flashLineBadge}
      onMouseMove={flashLineBadge}
    >
      <div ref={hostRef} className="absolute inset-0" />
      {/* Line indicator pill — replaces the gutter. Sits next to the
          scrollbar in the top-right of the editor host so it's visible while
          the user scrolls or hovers, and fades after a brief idle. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 8,
          insetInlineEnd: 12,
          padding: "3px 8px",
          fontSize: 11,
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          color: "hsl(var(--fg-muted))",
          background: "hsl(var(--bg-subtle))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 999,
          opacity: showLineBadge ? 0.95 : 0,
          transition: "opacity 200ms ease",
          pointerEvents: "none",
          zIndex: 5,
        }}
      >
        Line {currentLine}
      </div>
    </div>
  );
});
