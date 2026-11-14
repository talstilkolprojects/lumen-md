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
import { screenReaderAnnouncements } from "./srAnnouncements";
import { readyToReveal } from "./revealLine";
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { lineSeparatorFor } from "./lineEndings";
import { obsidianSourceExtension } from "./obsidianSource";
import { pastedHtmlToMarkdown, shouldConvertPaste } from "../paste/htmlPaste";
import { wysiwygTakesPaste, type PasteDetail } from "../paste/pasteCommands";
import { FIX_PDF_HEBREW_EVENT, fixSourceSelection, offerInSourceEditor } from "../paste/pdfPaste";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { actionById, applyTextAction, type ToolbarActionId } from "../mobile/toolbarActions";
import { wikiLinkCompletion } from "./wikiLinkComplete";
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
import { hebrewTypographyExtension } from "./hebrewTypographyExtension";
import { bidiMarksExtension } from "./bidiMarks";
import { mathBidiExtension } from "./mathBidi";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { embedHintExtension } from "./embedHintExtension";
import { insertSlashMenuExtension } from "./insertMenu";
import { wikiLinkAutocomplete } from "./wikiLinkAutocomplete";
import { wikiHover } from "./wikiHover";
import { collabAwarenessExtension } from "./collabAwareness";
import { t as i18nT, getLocale } from "../i18n";
// y-codemirror.next (and the yjs stack behind it) is loaded on demand inside
// the collab effect below — a static import dragged ~60KB gz of yjs into the
// eager boot path for a feature that's off until a session starts.
import { typewriterModeExtension } from "./typewriterMode";
import { ghostTextExtension } from "./ghostText";
import { useAppStore } from "../store/useStore";
import { markdownLintExtension } from "./lintExtension";
// commentDecorations imports yjs (comment anchors are Y.Map relative
// positions) — loaded on demand in the collab effect, like ySync below.
import { searchHighlightExtension } from "./searchHighlight";
import { showSpokenRange, showSpokenWord, speechHighlightExtension } from "./speechHighlight";
import { lexiconInstalled } from "../lexicon/installed";
import { wordAt } from "../lexicon/wordAt";
import { inlineSuggestion } from "./inlineSuggestion";
import { aiAuthorshipExtension } from "./aiAuthorship";
import { formatKeymap } from "./formatKeymap";
import { setSuggesting, suggestingAuthor, suggestingExtension, suggestingSkip } from "./suggestingExtension";
import { useAuth } from "../auth/useAuth";
import type { CollabSession } from "../collab/yjs";
import { joinTextEnvelope, splitTextEnvelope, type TextEnvelope } from "../storage/textCodec";

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
// Outline mode: folding, zoom and block operations (plan W2.13), loaded after mount.
const outlineCompartment = new Compartment();
// W1.2 — the document's own line ending, so a CRLF file saves as CRLF.
const lineSeparatorCompartment = new Compartment();

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
  /** The paste/drop image path, for the mobile toolbar's image button. */
  const assetFilesRef = useRef<((view: EditorView, files: File[]) => Promise<void>) | null>(null);
  // When the parent pushes a new value into the editor (file open),
  // we want to suppress the resulting onChange notification.
  const syncingRef = useRef(false);
  // The note's BOM and CRLF line breaks: hidden from CodeMirror (which shows
  // LF), written back on every change so a save keeps the file's bytes (W4.30).
  const envelopeRef = useRef<TextEnvelope>(splitTextEnvelope(value).envelope);
  const lastEmittedRef = useRef<string>(value);
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
        if (files.length === 0) {
          // W1.4 — HTML from Word, Google Docs or a website pastes as clean Markdown.
          const html = event.clipboardData?.getData("text/html");
          const text = event.clipboardData?.getData("text/plain");
          if (!html || !shouldConvertPaste(html, text)) return false;
          const md = pastedHtmlToMarkdown(html);
          if (!md) return false;
          event.preventDefault();
          const { from, to } = view.state.selection.main;
          view.dispatch({ changes: { from, to, insert: md }, selection: { anchor: from + md.length }, userEvent: "input.paste" });
          return true;
        }
        event.preventDefault();
        void handleAssetFiles(view, files);
        return true;
      },
      // Right-click on a Hebrew word (plan W5.26): synonyms, definition and niqqud from the offline
      // lexicon — only once its pack is installed; Shift+right-click keeps the browser's menu.
      contextmenu(event, view) {
        if (event.shiftKey || !lexiconInstalled()) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null || !wordAt(view, pos)) return false;
        event.preventDefault();
        const at = { x: event.clientX, y: event.clientY };
        void import("../lexicon/LexiconPopover").then(({ openLexicon }) => openLexicon(view, pos, at));
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
    const initialDoc = splitTextEnvelope(value).body;

    const baseExtensions = [
      lineSeparatorCompartment.of(EditorState.lineSeparator.of(lineSeparatorFor(initialDoc))),
      vimCompartment.of([]),
      embedHintExtension(),
      // W1.3 — ==highlights==, %%comments%% and callout heads, marked.
      obsidianSourceExtension,
      insertSlashMenuExtension(),
      wikiLinkCompletion(),
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
      // Hover over [[Note]] previews it (4.6).
      wikiHover,
      EditorView.lineWrapping,
      // Hebrew and English lines each read in their own direction (T25).
      bidiExtension(),
      // Hebrew typography as you type: ״ ׳ „” ־ – (plan W2.9).
      hebrewTypographyExtension(),
      bidiMarksExtension(),
      // W5.14 — inline formulas as LTR isolates, Ctrl/⌘+M, Hebrew layout inside math.
      mathBidiExtension(),
      // Accessible name for the contenteditable (role=textbox) surface —
      // without it, screen readers announce an unnamed input (axe:
      // aria-input-field-name).
      // tabindex makes the content explicitly focusable, so its scroller counts as keyboard-reachable (axe scrollable-region-focusable, plan 10.1).
      EditorView.contentAttributes.of({ "aria-label": i18nT("editor.ariaLabel"), tabindex: "0" }),
      // Spoken structure of the line the cursor lands on (plan W1.23).
      screenReaderAnnouncements(),
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
      outlineCompartment.of([]),
      // Live markdown lint — wavy underlines for trailing whitespace,
      // mixed-indent, heading-skip, broken wiki-links. Runs every 250 ms
      // after the user stops typing.
      markdownLintExtension(),
      // Workspace search → editor: when SearchDialog opens a hit, this
      // extension flashes the matches and scrolls the first one into view.
      searchHighlightExtension(),
      speechHighlightExtension(),
      // Plan 5.9: text the AI wrote is shown lighter until it is edited.
      aiAuthorshipExtension(() => {
        const d = useAppStore.getState().doc;
        return d.workspaceName ?? `file:${d.name}`;
      }),
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
      // W5.5 — Hebrew pasted from a PDF in visual order (or with broken finals): offer the fix.
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          if (!tr.isUserEvent("input.paste")) continue;
          tr.changes.iterChanges((_fa, _ta, fromB, _tb, text) => {
            const pasted = text.toString();
            if (pasted.length > 1) offerInSourceEditor(u.view, fromB, pasted);
          });
        }
      }),
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
          const next = joinTextEnvelope(u.state.doc.toString(), envelopeRef.current);
          lastEmittedRef.current = next;
          onChangeRef.current(next);
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

    async function handleAssetFiles(view: EditorView, dropped: File[]) {
      // Plan W5.11: a photo's GPS position, time and device are removed before
      // it is stored or inlined (src/lib/imageMetadata.ts), unless kept. Fail
      // closed (review 12.11): a photo that can't be cleaned is not added.
      const isPhoto = (f: File) => /^image\/(jpeg|png|webp)$/.test(f.type);
      let refused = 0;
      const files = dropped.some(isPhoto)
        ? await import("../lib/imageMetadata").then(
            async (m) =>
              (await Promise.all(dropped.map((f) => m.cleanImageFile(f).catch(() => null)))).filter((f): f is File => {
                if (f === null) refused++;
                return f !== null;
              }),
            () => {
              // why: the cleaner didn't load, so no photo can be cleaned: none is added
              const kept = dropped.filter((f) => !isPhoto(f));
              refused += dropped.length - kept.length;
              return kept;
            },
          )
        : dropped;
      if (refused > 0) {
        void Promise.all([import("../ui/PromptDialog"), import("../lib/journalistStrings")]).then(([{ uiAlert }]) =>
          uiAlert({ message: i18nT("photoMeta.refused", { count: refused }) }),
        );
      }
      if (!files.length) return;
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
    assetFilesRef.current = handleAssetFiles;



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
    const { body, envelope } = splitTextEnvelope(value);
    // A value from outside (file open, sync) brings its own BOM / line breaks;
    // our own emission keeps the ones the note was opened with.
    if (value !== lastEmittedRef.current) envelopeRef.current = envelope;
    lastEmittedRef.current = value;
    if (current === body) return;
    syncingRef.current = true;
    try {
      // A newly opened file may use other line endings: switch first, since
      // the inserted text is split with the separator in force before it.
      const sep = lineSeparatorFor(value);
      if (view.state.lineBreak !== sep) {
        view.dispatch({ effects: lineSeparatorCompartment.reconfigure(EditorState.lineSeparator.of(sep)) });
      }
      view.dispatch({
        changes: { from: 0, to: current.length, insert: body },
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
          // Plan W1.19: a "view" or "comment" participant can't change the
          // note (the server refuses it too); remote edits still apply.
          EditorState.transactionFilter.of((tr) =>
            !tr.docChanged ||
            collab.canEdit() ||
            (tr as unknown as { annotations: ReadonlyArray<{ value: unknown }> }).annotations.some((a) => a.value === syncConf)
              ? tr
              : [],
          ),
        ];
        if (collab.doc) commentsExt = commentDecorations({ doc: collab.doc, commentsDoc: collab.commentsDoc });
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

  // Outline mode and block operations (plan W2.13): its own lazy chunk.
  useEffect(() => {
    let cancelled = false;
    void import("./outlineExtension").then((m) => {
      const view = viewRef.current;
      if (cancelled || !view) return;
      view.dispatch({ effects: outlineCompartment.reconfigure(m.outlineExtension()) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Live dictation (plan 6.1): `lumen-dictation-insert` {text} inserts a
  // finished segment at the cursor with one separating space;
  // `lumen-dictation-undo` {text} removes it again when it is still right
  // before the cursor ("delete that"). preventDefault() tells the sender
  // the editor handled it; `detail.inserted` is what was actually inserted.
  useEffect(() => {
    function onDictation(e: Event) {
      const view = viewRef.current;
      const detail = (e as CustomEvent<{ text: string; inserted?: string }>).detail;
      const text = detail?.text;
      if (!view || !text) return;
      e.preventDefault();
      const { from, to } = view.state.selection.main;
      if (e.type === "lumen-dictation-undo") {
        if (view.state.sliceDoc(Math.max(0, from - text.length), from) === text) view.dispatch({ changes: { from: from - text.length, to: from, insert: "" } });
        return;
      }
      const before = from > 0 ? view.state.sliceDoc(from - 1, from) : "";
      const insert = before && !/\s/.test(before) && !/^[\s.,?!:)]/.test(text) ? " " + text : text;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
      detail.inserted = insert; // what to remove on "delete that"
    }
    window.addEventListener("lumen-dictation-insert", onDictation);
    window.addEventListener("lumen-dictation-undo", onDictation);
    return () => {
      window.removeEventListener("lumen-dictation-insert", onDictation);
      window.removeEventListener("lumen-dictation-undo", onDictation);
    };
  }, []);

  // Plugins (plan 11.2): `lumen-plugin-insert` {text} replaces the selection
  // with the text; `lumen-editor-selection` fills detail.result with the
  // selection. preventDefault() tells the sender the editor handled it.
  useEffect(() => {
    function onPluginInsert(e: Event) {
      const view = viewRef.current;
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!view || typeof text !== "string") return;
      e.preventDefault();
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    }
    function onSelection(e: Event) {
      const view = viewRef.current;
      const detail = (e as CustomEvent<{ result?: { from: number; to: number; text: string } | null }>).detail;
      if (!view || !detail) return;
      const { from, to } = view.state.selection.main;
      detail.result = { from, to, text: view.state.sliceDoc(from, to) };
    }
    window.addEventListener("lumen-plugin-insert", onPluginInsert);
    window.addEventListener("lumen-editor-selection", onSelection);
    return () => {
      window.removeEventListener("lumen-plugin-insert", onPluginInsert);
      window.removeEventListener("lumen-editor-selection", onSelection);
    };
  }, []);

  // W1.4 — "Paste as plain text" / "Paste with formatting" from the palette,
  // when the WYSIWYG editor is not the one showing.
  useEffect(() => {
    function onPaste(e: Event) {
      const view = viewRef.current;
      const detail = (e as CustomEvent<PasteDetail>).detail;
      if (!view || !detail || wysiwygTakesPaste()) return;
      const insert = detail.mode === "plain" ? detail.text : detail.markdown;
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.paste" });
      view.focus();
    }
    window.addEventListener("lumen-paste", onPaste);
    return () => window.removeEventListener("lumen-paste", onPaste);
  }, []);

  // The mobile toolbar (plan W1.25) sends `lumen-mobile-action` {id}. Text
  // actions are one transaction each, so one undo takes one back.
  useEffect(() => {
    function onAction(e: Event) {
      const view = viewRef.current;
      const id = (e as CustomEvent<{ id: ToolbarActionId }>).detail?.id;
      const action = id ? actionById(id) : undefined;
      if (!view || !action) return;
      if (action.kind === "history") {
        (id === "undo" ? undo : redo)(view);
      } else if (action.kind === "keyboard") {
        view.contentDOM.blur();
        return;
      } else if (action.kind === "image") {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.onchange = () => {
          const files = Array.from(input.files ?? []);
          if (files.length && assetFilesRef.current) void assetFilesRef.current(view, files);
        };
        input.click();
        return;
      } else {
        const { from, to } = view.state.selection.main;
        const edit = applyTextAction(id!, view.state.doc.toString(), from, to);
        if (edit && (edit.changes.length || edit.anchor !== from || edit.head !== to)) {
          view.dispatch({
            changes: edit.changes,
            selection: { anchor: edit.anchor, head: edit.head },
            scrollIntoView: true,
            userEvent: "input.mobile-toolbar",
          });
        }
      }
      view.focus();
    }
    window.addEventListener("lumen-mobile-action", onAction);
    return () => window.removeEventListener("lumen-mobile-action", onAction);
  }, []);

  // W5.5 — "Fix reversed Hebrew (from a PDF)" on the selection, from the palette.
  useEffect(() => {
    function onFix(e: Event) {
      const view = viewRef.current;
      const done = (e as CustomEvent<{ done: (message: string | null) => void }>).detail?.done;
      if (!view || !done || wysiwygTakesPaste()) return;
      done(fixSourceSelection(view));
    }
    window.addEventListener(FIX_PDF_HEBREW_EVENT, onFix);
    return () => window.removeEventListener(FIX_PDF_HEBREW_EVENT, onFix);
  }, []);

  // `lumen-reveal-line` {line} (1-based): jump to and select that line —
  // used by vault citations (T29). With `content` it waits until the
  // just-opened note has actually loaded into the editor.
  useEffect(() => {
    function onReveal(e: Event) {
      // `select: false` (a tap on reading view, W1.25) puts the cursor at the line's end instead of selecting it.
      const detail = (e as CustomEvent<{ line: number; content?: string; select?: boolean }>).detail;
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
        view.dispatch({ selection: detail.select === false ? { anchor: l.to } : { anchor: l.from, head: l.to }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
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
    // `lumen-speech-word` {from, to} | null: the word inside it (plan W5.6).
    function onWord(e: Event) {
      const view = viewRef.current;
      if (!view) return;
      showSpokenWord(view, (e as CustomEvent<{ from: number; to: number } | null>).detail ?? null);
    }
    window.addEventListener("lumen-speech-range", onSelect);
    window.addEventListener("lumen-speech-word", onWord);
    return () => {
      window.removeEventListener("lumen-speech-range", onSelect);
      window.removeEventListener("lumen-speech-word", onWord);
    };
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
        {i18nT("editor.line", { n: currentLine })}
      </div>
    </div>
  );
});
