import { useEffect, useRef } from "react";
import {
  Editor as MilkdownEditor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  prosePluginsCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { clipboard } from "@milkdown/plugin-clipboard";
import { math } from "@milkdown/plugin-math";
import { slashFactory, SlashProvider } from "@milkdown/plugin-slash";
import { tooltipFactory, TooltipProvider } from "@milkdown/plugin-tooltip";
import { setBlockType, toggleMark, wrapIn } from "@milkdown/prose/commands";
import type { EditorView } from "@milkdown/prose/view";
import { Plugin } from "@milkdown/prose/state";
import { wysiwygBidiPlugin } from "./wysiwygBidi";
import { wrapInList } from "prosemirror-schema-list";
import { dragHandlePlugin } from "./dragHandles";
import { buildIndentKeymap } from "./keymapExtra";
import "katex/dist/katex.css";
import { chat, AiError } from "../ai/llm";
import { PROMPTS } from "../ai/prompts";
import { showAiToast } from "../ui/AiToast";
import { openAiPrompt } from "../ui/AiInlinePrompt";
import { log } from "../lib/logger";
import { getMarkdown } from "@milkdown/utils";
import {
  configureWysiwygSuggest,
  encodeCriticForWysiwyg,
  registerWysiwygView,
  unregisterWysiwygView,
  wysiwygSuggestPlugins,
} from "./wysiwygSuggest";
import { keepWikiLinks, protectEscapedWikiLinks } from "./wysiwygWikiLinks";
import { wysiwygWikiComplete } from "./wysiwygWikiComplete";
import { registerPendingEdits, useAppStore } from "../store/useStore";
import { useAuth } from "../auth/useAuth";
import { t } from "../i18n";

// Suggesting mode (track changes) works in WYSIWYG too: CriticMarkup ↔
// marks, edits tracked while the store's suggestingMode is on.
configureWysiwygSuggest({
  enabled: () => useAppStore.getState().suggestingMode,
  author: () => {
    const user = useAuth.getState().user;
    return user?.name?.trim() || user?.email?.split("@")[0] || null;
  },
});

interface Props {
  value: string;
  onChange: (next: string) => void;
}

const slash = slashFactory("wysiwyg-slash");
const tooltip = tooltipFactory("wysiwyg-tooltip");

interface SlashItem {
  label: string;
  icon: string;
  /** Search keywords beyond label — typing any of these still surfaces it. */
  keywords?: string[];
  /** Category header used by the renderer for grouping. */
  group: "Headings" | "Lists" | "Blocks" | "Media" | "Data" | "AI";
  run: (view: EditorView) => void;
}

/**
 * Insert a verbatim markdown source block at the current selection. Used
 * for blocks that aren't part of the Milkdown schema (charts, csv-tables,
 * mermaid). The text is inserted as a code-block node with the matching
 * `language` so the round-trip to source preserves it.
 */
function insertCodeFence(v: EditorView, lang: string, body: string): void {
  const node = v.state.schema.nodes.code_block;
  if (!node) return;
  const tr = v.state.tr.replaceSelectionWith(
    node.create({ language: lang }, v.state.schema.text(body)),
  );
  v.dispatch(tr);
}

function buildSlashItems(): SlashItem[] {
  const heading = (level: number): SlashItem => ({
    label: `Heading ${level}`,
    icon: `H${level}`,
    keywords: ["title", `h${level}`],
    group: "Headings",
    run: (v) => {
      const node = v.state.schema.nodes.heading;
      if (node) setBlockType(node, { level })(v.state, v.dispatch);
    },
  });
  return [
    heading(1),
    heading(2),
    heading(3),
    heading(4),
    {
      label: "Bullet list",
      icon: "•",
      keywords: ["ul", "unordered"],
      group: "Lists",
      run: (v) => {
        const node = v.state.schema.nodes.bullet_list;
        if (node) wrapInList(node)(v.state, v.dispatch);
      },
    },
    {
      label: "Ordered list",
      icon: "1.",
      keywords: ["ol", "numbered"],
      group: "Lists",
      run: (v) => {
        const node = v.state.schema.nodes.ordered_list;
        if (node) wrapInList(node)(v.state, v.dispatch);
      },
    },
    {
      label: "Task list",
      icon: "☐",
      keywords: ["todo", "checkbox", "checklist"],
      group: "Lists",
      run: (v) => {
        const node = v.state.schema.nodes.bullet_list;
        if (!node) return;
        const before = v.state.doc;
        wrapInList(node)(v.state, v.dispatch);
        // Wrapping can be refused (suggesting mode): then add no marker.
        if (v.state.doc === before) return;
        // Inject a leading checkbox marker so the round-trip to markdown
        // produces `- [ ] ...` on the new line.
        const tr = v.state.tr.insertText("[ ] ", v.state.selection.from);
        v.dispatch(tr);
      },
    },
    {
      label: "Blockquote",
      icon: "❝",
      keywords: ["quote", "cite"],
      group: "Blocks",
      run: (v) => {
        const node = v.state.schema.nodes.blockquote;
        if (node) wrapIn(node)(v.state, v.dispatch);
      },
    },
    {
      label: "Code block",
      icon: "</>",
      keywords: ["code", "snippet", "fence"],
      group: "Blocks",
      run: (v) => {
        const node = v.state.schema.nodes.code_block;
        if (node) setBlockType(node)(v.state, v.dispatch);
      },
    },
    {
      label: "Math block",
      icon: "∑",
      keywords: ["latex", "tex", "equation", "formula"],
      group: "Blocks",
      run: (v) => {
        const node = v.state.schema.nodes.math_block;
        if (node) setBlockType(node)(v.state, v.dispatch);
      },
    },
    {
      label: "Callout",
      icon: "💡",
      keywords: ["note", "tip", "warning", "info", "admonition"],
      group: "Blocks",
      run: (v) => {
        const tr = v.state.tr.insertText(
          ":::note\nWrite your callout here.\n:::\n",
          v.state.selection.from,
        );
        v.dispatch(tr);
      },
    },
    {
      label: "Columns",
      icon: "▥",
      keywords: ["columns", "two-column", "side-by-side", "layout"],
      group: "Blocks",
      run: (v) => {
        const tr = v.state.tr.insertText(
          ":::columns{cols=2}\nLeft column.\n:::\nRight column.\n:::\n",
          v.state.selection.from,
        );
        v.dispatch(tr);
      },
    },
    {
      label: "Divider",
      icon: "—",
      keywords: ["hr", "rule", "separator"],
      group: "Blocks",
      run: (v) => {
        const hr = v.state.schema.nodes.hr;
        if (!hr) return;
        v.dispatch(v.state.tr.replaceSelectionWith(hr.create()));
      },
    },
    {
      label: "Table",
      icon: "▦",
      keywords: ["grid", "rows", "cols"],
      group: "Data",
      run: (v) => {
        const tr = v.state.tr.insertText(
          "| Col 1 | Col 2 | Col 3 |\n| :--- | :---: | ---: |\n| L | C | R |\n| Data | Data | Data |\n",
          v.state.selection.from,
        );
        v.dispatch(tr);
      },
    },
    {
      label: "CSV table",
      icon: "📊",
      keywords: ["data", "csv", "spreadsheet"],
      group: "Data",
      run: (v) =>
        insertCodeFence(
          v,
          "csv",
          "month,revenue\nJan,4200\nFeb,4800\nMar,5100",
        ),
    },
    {
      label: "Chart",
      icon: "📈",
      keywords: ["echarts", "plot", "graph", "visualisation"],
      group: "Data",
      run: (v) =>
        insertCodeFence(
          v,
          "chart",
          'title:\n  text: My chart\nxAxis:\n  type: category\n  data: [Jan, Feb, Mar]\nyAxis:\n  type: value\nseries:\n  - name: Sales\n    type: bar\n    data: [12, 19, 8]',
        ),
    },
    {
      label: "Mermaid diagram",
      icon: "🧩",
      keywords: ["flowchart", "sequence", "graph", "diagram"],
      group: "Data",
      run: (v) =>
        insertCodeFence(
          v,
          "mermaid",
          "flowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Path A]\n  B -->|No| D[Path B]",
        ),
    },
    {
      label: "Image",
      icon: "🖼",
      keywords: ["picture", "img", "photo"],
      group: "Media",
      run: (v) => {
        const tr = v.state.tr.insertText(
          "![alt text](https://example.com/image.png)",
          v.state.selection.from,
        );
        v.dispatch(tr);
      },
    },
    {
      label: "Embed (YouTube / Tweet / Map…)",
      icon: "🌐",
      keywords: ["video", "youtube", "twitter", "x", "vimeo", "embed", "map"],
      group: "Media",
      run: (v) =>
        insertCodeFence(v, "embed", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    },
    {
      label: "AI Ghostwriter",
      icon: "✨",
      keywords: ["ai", "write", "complete", "draft"],
      group: "AI",
      run: async (v) => {
        const promptStr = await openAiPrompt("What do you want the AI to write about?");
        if (!promptStr) return;

        const placeholder = "🤖 Thinking...";
        const { state } = v;
        const insertPos = state.selection.from;
        v.dispatch(state.tr.insertText(placeholder, insertPos));

        try {
          let accumulated = "";
          const { streamAgent } = await import("../agents/runtime");
          const { writerAgent } = await import("../agents/defs");
          const stream = streamAgent(writerAgent, { text: promptStr }, { ownPrompt: true });
          // Remove placeholder before streaming
          const removeTr = v.state.tr;
          removeTr.delete(insertPos, insertPos + placeholder.length);
          v.dispatch(removeTr);

          for await (const chunk of stream) {
            accumulated += chunk;
            // Replace accumulated text at insert position
            const tr = v.state.tr;
            const endOfText = insertPos + accumulated.length - chunk.length;
            tr.insertText(chunk, endOfText);
            v.dispatch(tr);
          }
        } catch (e) {
          log.error("WYSIWYG AI stream failed", e);
          // If placeholder is still there, replace it
          const docText = v.state.doc.textBetween(insertPos, Math.min(insertPos + placeholder.length, v.state.doc.content.size));
          if (docText === placeholder) {
            const errTr = v.state.tr;
            errTr.delete(insertPos, insertPos + placeholder.length);
            errTr.insertText(e instanceof AiError && e.code === "NO_KEY" ? "⚠️ Configure AI Key (⌘K)" : "❌ AI Failed", insertPos);
            v.dispatch(errTr);
          }
          showAiToast(
            e instanceof AiError && e.code === "NO_KEY"
              ? "Please configure your AI Key (⌘K → AI Settings)"
              : `AI Ghostwriter failed: ${(e as Error)?.message ?? "unknown error"} (⌘K → AI: Recent Agent Runs)`,
            "error",
          );
        }
      },
    },
  ];
}

/**
 * Filter slash items by a free-text query (matches label + keywords).
 * Empty query returns the full list.
 */
function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    if (it.label.toLowerCase().includes(q)) return true;
    return it.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false;
  });
}

/**
 * Render the slash menu as DOM. Supports:
 *   - category headers (Headings / Lists / Blocks / Data / Media / AI)
 *   - keyboard navigation via ↑/↓/Enter (driven by the EditorView's keymap)
 *   - live filter via `setQuery(q)` exposed on the returned element
 *   - selection highlight via `data-selected="true"` attribute
 *
 * The function returns the root `<div>` extended with helpers so the
 * Milkdown SlashProvider can drive it.
 */
interface SlashMenuRoot extends HTMLDivElement {
  setQuery(q: string): void;
  moveSelection(delta: number): void;
  runSelected(): void;
}

function buildSlashMenu(getView: () => EditorView | null): SlashMenuRoot {
  const el = document.createElement("div") as SlashMenuRoot;
  el.className = "milkdown-slash-menu";
  el.dataset.show = "false";

  const all = buildSlashItems();
  let visible: SlashItem[] = all;
  let selectedIndex = 0;

  function commit(item: SlashItem) {
    const view = getView();
    if (!view) return;
    // Strip the `/` trigger plus any query the user typed after it.
    const { state } = view;
    const { $from } = state.selection;
    const text = $from.parent.textBetween(
      0,
      $from.parentOffset,
      undefined,
      "\u00A0",
    );
    const slashIdx = text.lastIndexOf("/");
    if (slashIdx >= 0) {
      const from = $from.start() + slashIdx;
      view.dispatch(state.tr.delete(from, $from.pos));
    }
    item.run(view);
    view.focus();
  }

  function render(): void {
    el.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "milkdown-slash-empty";
      empty.textContent = "No matches";
      empty.style.padding = "10px 14px";
      empty.style.fontSize = "11.5px";
      empty.style.color = "hsl(var(--fg-muted))";
      el.appendChild(empty);
      return;
    }
    let prevGroup: string | null = null;
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      if (item.group !== prevGroup) {
        const head = document.createElement("div");
        head.className = "milkdown-slash-group";
        head.textContent = item.group;
        head.style.padding = "6px 12px 2px";
        head.style.fontSize = "10px";
        head.style.fontWeight = "700";
        head.style.letterSpacing = "0.05em";
        head.style.textTransform = "uppercase";
        head.style.color = "hsl(var(--fg-muted))";
        el.appendChild(head);
        prevGroup = item.group;
      }
      const row = document.createElement("div");
      row.className = "milkdown-slash-item";
      row.tabIndex = -1;
      row.dataset.index = String(i);
      if (i === selectedIndex) row.dataset.selected = "true";

      const icon = document.createElement("span");
      icon.className = "slash-icon";
      icon.textContent = item.icon;

      const label = document.createElement("span");
      label.className = "slash-label";
      label.textContent = item.label;

      row.appendChild(icon);
      row.appendChild(label);
      row.addEventListener("mouseenter", () => {
        selectedIndex = i;
        for (const r of el.querySelectorAll<HTMLElement>(".milkdown-slash-item")) {
          delete r.dataset.selected;
        }
        row.dataset.selected = "true";
      });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        commit(item);
      });
      el.appendChild(row);
    }
  }

  el.setQuery = (q: string) => {
    visible = filterSlashItems(all, q);
    selectedIndex = 0;
    render();
  };
  el.moveSelection = (delta: number) => {
    if (visible.length === 0) return;
    selectedIndex =
      (selectedIndex + delta + visible.length) % visible.length;
    render();
    const sel = el.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    sel?.scrollIntoView({ block: "nearest" });
  };
  el.runSelected = () => {
    const it = visible[selectedIndex];
    if (it) commit(it);
  };

  render();
  return el;
}

interface TooltipBtn {
  label: string;
  title: string;
  run: (v: EditorView) => void;
}

function buildTooltip(getView: () => EditorView | null): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "milkdown-tooltip";
  el.dataset.show = "false";

  const buttons: TooltipBtn[] = [
    {
      label: "B",
      title: "Bold",
      run: (v) => {
        const m = v.state.schema.marks.strong;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "I",
      title: "Italic",
      run: (v) => {
        const m = v.state.schema.marks.emphasis;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "S",
      title: "Strikethrough",
      run: (v) => {
        const m = v.state.schema.marks.strike_through;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "</>",
      title: "Inline code",
      run: (v) => {
        const m = v.state.schema.marks.code_inline ?? v.state.schema.marks.inlineCode;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "🔗",
      title: "Link",
      run: async (v) => {
        const m = v.state.schema.marks.link;
        if (!m) return;
        const url = await openAiPrompt("URL:");
        if (!url) return;
        toggleMark(m, { href: url })(v.state, v.dispatch);
      },
    },
    {
      label: "✨",
      title: "AI Rewrite",
      run: async (v) => {
        const { state, dispatch } = v;
        const { from, to } = state.selection;
        if (from === to) return;
        
        const selectedText = state.doc.textBetween(from, to, "\n");
        const instructions = await openAiPrompt("How should the AI rewrite this? (e.g. 'Make it professional', 'Translate to Spanish')");
        if (!instructions) return;
        
        const { aiOperation, isAbort } = await import("../ai/aiAbort");
        const op = aiOperation();
        try {
          const rewritten = await chat(
            [
              { role: "system", content: PROMPTS.rewrite },
              { role: "user", content: `Instruction: ${instructions}\n\nText: ${selectedText}` },
            ],
            { ownPrompt: true, signal: op.signal },
          );
          dispatch(state.tr.replaceWith(from, to, state.schema.text(rewritten)));
        } catch (e) {
          if (isAbort(e)) return;
          log.error("WYSIWYG AI rewrite failed", e);
          // A spent quota already showed its own toast.
          if (!(e instanceof Error && e.name === "AiQuotaExceededError")) showAiToast(t("toast.aiRewriteFailed"), "error");
        } finally {
          op.end();
        }
      },
    },
  ];

  for (const btn of buttons) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = btn.title;
    b.textContent = btn.label;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const view = getView();
      if (!view) return;
      btn.run(view);
      view.focus();
    });
    el.appendChild(b);
  }
  return el;
}

/**
 * WYSIWYG editor powered by Milkdown (ProseMirror under the hood).
 * Recreates on external `value` changes (file open). Internal edits stream out
 * via the listener plugin.
 *
 * Includes math (KaTeX), a `/` slash command menu, and a selection tooltip
 * for inline formatting.
 */
/**
 * Split a leading YAML frontmatter block off a markdown document. Milkdown
 * has no frontmatter concept — fed raw, `---\ntitle: …\n---` renders as a
 * thematic break + loose text (ugly, and editing it corrupts the metadata).
 * We keep the block verbatim and re-prepend it on every emission, so the
 * metadata survives WYSIWYG editing invisibly.
 */
export function splitFrontmatter(md: string): { fm: string; body: string } {
  const m = md.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: "", body: md };
  return { fm: m[0], body: md.slice(m[0].length) };
}

export default function WysiwygEditor({ value, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MilkdownEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastEmittedRef = useRef<string>(value);
  // Leading YAML frontmatter of the current document — hidden from Milkdown,
  // re-attached to every onChange so it is preserved, not destroyed.
  const frontmatterRef = useRef<string>("");

  // DOM elements + view ref reused across editor recreations.
  const slashElRef = useRef<HTMLDivElement | null>(null);
  const tooltipElRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const getView = () => viewRef.current;

  // ── Lifecycle sequencing ─────────────────────────────────────────
  // Milkdown's `create()` and `destroy()` are both async, and
  // `destroy()` called while another `destroy()` is in flight resolves
  // immediately (status OnDestroy) — so naive "destroy then create"
  // effects let two editors mount into the same host at once (rapid
  // mode switches, StrictMode's mount→unmount→remount, or a value
  // change landing while the previous rebuild is still awaiting).
  //
  // Every lifecycle operation is therefore appended to ONE promise
  // chain per component instance, and each build carries a generation
  // number. A build whose generation has been superseded by the time it
  // runs (or by the time its `create()` resolves) is skipped / torn down,
  // and unmount bumps the generation and queues the final teardown
  // behind any in-flight build. Net effect: at most one editor is ever
  // alive, and destroy never overlaps create.
  const lifecycleRef = useRef<Promise<void>>(Promise.resolve());
  const genRef = useRef(0);
  const enqueue = (op: () => Promise<void>) => {
    lifecycleRef.current = lifecycleRef.current
      .then(op)
      .catch((e) => log.warn("[wysiwyg] lifecycle op threw", e));
  };
  // The editor's markdown as of its creation / last emission: on unmount,
  // anything else is an edit the debounced listener hasn't emitted yet.
  const serializedRef = useRef<string | null>(null);
  // This instance's view as registered for the palette's commands; another
  // instance (Focus Mode over the main editor) may be registered too, so
  // only this one is unregistered.
  const registeredViewRef = useRef<EditorView | null>(null);
  // Emit, synchronously, an edit the debounced listener hasn't emitted yet.
  const flushPending = () => {
    const ed = editorRef.current;
    if (!ed || serializedRef.current === null) return;
    let md: string;
    try {
      md = ed.action(getMarkdown());
    } catch {
      return; // editor already torn down
    }
    if (md === serializedRef.current) return;
    serializedRef.current = md;
    const full = frontmatterRef.current + md;
    if (full !== lastEmittedRef.current) {
      lastEmittedRef.current = full;
      onChangeRef.current(full);
    }
  };
  // Switching or closing the active tab inside the debounce window: the
  // `[value]` rebuild below would drop the edit (its generation guard), and
  // by then `onChange` already writes the NEW active document. The store
  // calls this before it switches, while the edit's own document is active.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => registerPendingEdits(flushPending), []);
  // Milkdown's listener debounces by 200 ms and can't be cancelled; its
  // timer serializes the document, which throws once the editor is gone.
  // When an emission is still pending, destroy only after it has run (its
  // output is ignored by the generation guard).
  const pendingSinceRef = useRef(0);
  const destroyCurrent = async () => {
    const ed = editorRef.current;
    editorRef.current = null;
    serializedRef.current = null;
    if (registeredViewRef.current) unregisterWysiwygView(registeredViewRef.current);
    registeredViewRef.current = null;
    if (!ed) return;
    const pending = Date.now() - pendingSinceRef.current;
    if (pending < 260) await new Promise((r) => setTimeout(r, 260 - pending));
    try {
      await ed.destroy(true);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!hostRef.current) return;
    // Skip rebuild when the editor already exists and content matches —
    // this short-circuits the typical "user typed, parent re-rendered"
    // round-trip.
    if (editorRef.current && lastEmittedRef.current === value) return;
    const gen = ++genRef.current;
    const host = hostRef.current;

    enqueue(async () => {
      if (gen !== genRef.current) return; // superseded before it started
      await destroyCurrent();
      if (gen !== genRef.current) return;
      host.replaceChildren();

      // Create floating menu DOMs lazily and reuse them.
      if (!slashElRef.current) slashElRef.current = buildSlashMenu(getView);
      if (!tooltipElRef.current) tooltipElRef.current = buildTooltip(getView);

      // Hide YAML frontmatter from the WYSIWYG surface; it is re-attached on
      // every emission below so external value/lastEmitted comparisons keep
      // operating on the full document.
      const { fm, body } = splitFrontmatter(value);
      frontmatterRef.current = fm;

      const editor = await MilkdownEditor.make()
        .config((ctx) => {
          ctx.set(rootCtx, host);
          // An escaped `\[\[x]]` stays escaped (not a wiki link) on the way out.
          ctx.set(defaultValueCtx, encodeCriticForWysiwyg(protectEscapedWikiLinks(body)));
          // `[[Note]]` is written back as is, not as `\[\[Note]]`.
          ctx.update(remarkStringifyOptionsCtx, keepWikiLinks);
          ctx.get(listenerCtx).markdownUpdated((_, md) => {
            // The listener plugin debounces emissions by 200ms and
            // nothing cancels that timer on destroy, so a torn-down (or
            // superseded) editor can still fire here. Forwarding it would
            // overwrite the store with stale content after a mode switch.
            if (gen !== genRef.current) return;
            if (md === serializedRef.current) return; // already flushed
            serializedRef.current = md;
            const full = frontmatterRef.current + md;
            lastEmittedRef.current = full;
            onChangeRef.current(full);
          });
          // γ.1 — drag-handles per top-level block. The plugin reads /
          // writes its own meta key and registers `Decoration.widget`s
          // on every block; the host's mousemove listener toggles
          // visibility of the handle for the hovered row.
          ctx.update(prosePluginsCtx, (plugins) => [
            ...plugins,
            // 4.5 — `[[` completes notes, `#` headings, `^` blocks. First, so
            // Enter / Tab in its menu pick a link (not split or indent).
            wysiwygWikiComplete(),
            dragHandlePlugin,
            // T25 — every block reads in the direction of its own text.
            wysiwygBidiPlugin(),
            new Plugin({
              appendTransaction: (trs) => {
                if (trs.some((t) => t.docChanged || t.storedMarksSet)) pendingSinceRef.current = Date.now();
                return null;
              },
            }),
            // γ.1.b — Tab / Shift-Tab indent / outdent inside lists.
            buildIndentKeymap(),
          ]);

          ctx.set(slash.key, {
            view: (view: EditorView) => {
              try {
                return buildSlashView(view);
              } catch (err) {
                // Last-resort guard: if Milkdown's SlashProvider
                // constructor throws (e.g. because the menu element was
                // detached during a re-mount before this callback fired),
                // contain the throw here. Returning a no-op view keeps
                // the plugin slot occupied so the editor finishes
                // setup; the cleanup pass will tear it down normally.
                log.warn("[wysiwyg] slash view threw, using no-op", err);
                return { update: () => {}, destroy: () => {} };
              }
            },
          });

          // Helper extracted for the try/catch above.
          function buildSlashView(view: EditorView) {
              const maybeMenu = slashElRef.current as SlashMenuRoot | null;
              // RACE GUARD — `MilkdownEditor.create()` is async, and this
              // view callback fires inside the ProseView constructor that
              // runs during that promise's resolution. If the value
              // effect's cleanup ran first (component unmount or value
              // change) and useEffect2's cleanupDom already nulled the
              // ref, `maybeMenu` is null here. Constructing
              // `new SlashProvider({ content: null })` would later throw
              // on its first debounced update (`appendChild` on null,
              // then `this.element.dataset` on null). A no-op view is
              // safe because the surrounding async block tears the
              // editor down right after via the `if (cancelled)` branch.
              if (!maybeMenu) {
                return { update: () => {}, destroy: () => {} };
              }
              // Reassign so inner function declarations capture the
              // narrowed (non-null) type.
              const menuEl: SlashMenuRoot = maybeMenu;
              viewRef.current = view;
              const provider = new SlashProvider({
                content: menuEl,
                debounce: 50,
                trigger: "/",
              });
              provider.update(view);

              // Live filter — read the text typed after the most recent
              // `/` and forward it into the menu so it shows only matching
              // items. Runs on every editor update.
              function syncQuery(v: EditorView) {
                const { $from } = v.state.selection;
                const text = $from.parent.textBetween(
                  0,
                  $from.parentOffset,
                  undefined,
                  "\u00A0",
                );
                const slashIdx = text.lastIndexOf("/");
                const q = slashIdx >= 0 ? text.slice(slashIdx + 1) : "";
                menuEl.setQuery(q);
              }
              syncQuery(view);

              // Keyboard navigation — only intercept while the menu is
              // visible (data-show="true"). Avoids stealing keys from the
              // editor when the slash menu is closed.
              const onKeyDown = (e: KeyboardEvent) => {
                if (menuEl.dataset.show !== "true") return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  menuEl.moveSelection(1);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  menuEl.moveSelection(-1);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  menuEl.runSelected();
                }
              };
              window.addEventListener("keydown", onKeyDown, { capture: true });

              return {
                update: (v: EditorView, prev: EditorView["state"]) => {
                  viewRef.current = v;
                  provider.update(v, prev);
                  syncQuery(v);
                },
                destroy: () => {
                  window.removeEventListener("keydown", onKeyDown, {
                    capture: true,
                  });
                  provider.destroy();
                  if (viewRef.current === view) viewRef.current = null;
                },
              };
          }

          ctx.set(tooltip.key, {
            view: (view: EditorView) => {
              try {
                return buildTooltipView(view);
              } catch (err) {
                // Same containment as slash view above.
                log.warn("[wysiwyg] tooltip view threw, using no-op", err);
                return { update: () => {}, destroy: () => {} };
              }
            },
          });

          function buildTooltipView(view: EditorView) {
              const tooltipEl = tooltipElRef.current;
              // Same race guard as the slash plugin above.
              if (!tooltipEl) {
                return { update: () => {}, destroy: () => {} };
              }
              viewRef.current = view;
              const provider = new TooltipProvider({
                content: tooltipEl,
                debounce: 50,
              });
              provider.update(view);
              return {
                update: (v: EditorView, prev: EditorView["state"]) => {
                  viewRef.current = v;
                  provider.update(v, prev);
                },
                destroy: () => {
                  provider.destroy();
                  if (viewRef.current === view) viewRef.current = null;
                },
              };
          }
        })
        // First, so suggestion marks wrap other marks (`{++**b**++}`).
        .use(wysiwygSuggestPlugins)
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener)
        .use(clipboard)
        .use(math)
        .use(slash)
        .use(tooltip)
        .create();

      if (gen !== genRef.current) {
        // Superseded (unmount or newer value) while create() was pending.
        // The queue guarantees nothing else touched the host meanwhile.
        try {
          await editor.destroy(true);
        } catch {
          /* ignore */
        }
        return;
      }
      editorRef.current = editor;
      lastEmittedRef.current = value;
      registeredViewRef.current = editor.action((ctx) => ctx.get(editorViewCtx));
      registerWysiwygView(registeredViewRef.current);
      serializedRef.current = editor.action(getMarkdown());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Final teardown — queued behind any in-flight build so the floating
  // menu DOM is only removed once no plugin view can still reference it.
  useEffect(() => {
    return () => {
      // Leaving WYSIWYG (mode switch): the listener debounces emissions
      // by 200 ms, so the last edits would be dropped by the generation
      // guard below. Flush them now, synchronously.
      flushPending();
      genRef.current++;
      enqueue(async () => {
        await destroyCurrent();
        slashElRef.current?.remove();
        slashElRef.current = null;
        tooltipElRef.current?.remove();
        tooltipElRef.current = null;
        viewRef.current = null;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="wysiwyg-host h-full overflow-y-auto">
      <div ref={hostRef} className="prose-lumen wysiwyg-root" />
    </div>
  );
}
