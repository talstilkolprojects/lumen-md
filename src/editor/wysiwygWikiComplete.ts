/**
 * `[[` link completion in the WYSIWYG editor (4.5) — the ProseMirror twin
 * of the source editor's CodeMirror source. Same parsing, matching and
 * edit rules (`wikiComplete`), same notes (the shared workspace index);
 * only the popup is its own, styled like the slash menu.
 *
 * Keys while it is open: ↑ / ↓ choose, Enter or Tab insert, Esc closes it
 * for this link.
 */

import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { t } from "../i18n";
import { parseWikiQuery, wikiEdit, wikiSuggestions, type WikiQuery, type WikiSuggestion } from "./wikiComplete";
import { canCreateNotes, createLinkedNote, currentNote, displayOf, linkCatalog } from "./wikiLinkData";

export const wikiCompleteKey = new PluginKey("lumenWikiComplete");

interface At {
  /** Document position of the textblock's start: line offsets are relative to it. */
  start: number;
  before: string;
  after: string;
  q: WikiQuery;
}

/** The `[[` being typed at the caret, or null (selection, code, no open link). */
function contextAt(view: EditorView): At | null {
  const sel = view.state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  const block = $from.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  if ($from.marks().some((m) => m.type.spec.code || m.type.name === "inlineCode")) return null;
  // One character per inline leaf (images, breaks): offsets are positions.
  const before = block.textBetween(0, $from.parentOffset, undefined, "￼");
  const q = parseWikiQuery(before);
  if (!q) return null;
  const after = block.textBetween($from.parentOffset, block.content.size, undefined, "￼");
  return { start: $from.start(), before, after, q };
}

/**
 * The headings of the document being edited, as it is now. The store's copy
 * lags the editor by Milkdown's 200 ms debounce, so a heading just typed or
 * renamed would be missing from `[[#`.
 */
function liveHeadings(doc: ProseNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === "heading") {
      // Empty ones too: they take part in the slug numbering.
      out.push(n.textContent);
      return false;
    }
    return !n.isTextblock;
  });
  return out;
}

const ICONS: Record<WikiSuggestion["kind"], string> = { note: "▤", alias: "≈", heading: "#", block: "^", create: "+" };

let menuSeq = 0;

class WikiMenu {
  readonly el: HTMLDivElement;
  private items: WikiSuggestion[] = [];
  private selected = 0;
  /** The text before the caret the shown items are for. */
  private shownFor = "";
  private seq = 0;
  /** Esc closed the menu for the link opened here, until the caret leaves it. */
  private dismissed: number | null = null;
  private readonly id = `lumen-wiki-menu-${++menuSeq}`;

  constructor(private view: EditorView) {
    this.el = document.createElement("div");
    this.el.className = "lumen-wiki-menu";
    this.el.dataset.show = "false";
    this.el.dataset.testid = "wiki-complete-menu";
    this.el.id = this.id;
    this.el.setAttribute("role", "listbox");
    this.el.setAttribute("aria-label", t("wikiComplete.listLabel"));
    document.body.appendChild(this.el);
  }

  get visible(): boolean {
    return this.el.dataset.show === "true";
  }

  update(view: EditorView): void {
    this.view = view;
    const at = contextAt(view);
    if (!at) {
      this.dismissed = null;
      return this.hide();
    }
    const opened = at.start + at.q.open;
    if (this.dismissed !== null && this.dismissed !== opened) this.dismissed = null;
    if (this.dismissed === opened) return this.hide();
    const key = `${at.start}:${at.before}`;
    if (key === this.shownFor && this.visible) return this.place(at);
    this.shownFor = key;
    const seq = ++this.seq;
    void linkCatalog()
      .then((catalog) => {
        if (seq !== this.seq) return;
        const now = contextAt(this.view);
        if (!now || `${now.start}:${now.before}` !== key) return;
        const doc = this.view.state.doc;
        this.show(now, wikiSuggestions(now.q, catalog, { ...currentNote(), headings: () => liveHeadings(doc) }, { create: canCreateNotes() }));
      })
      .catch(() => undefined);
  }

  private show(at: At, items: WikiSuggestion[]): void {
    this.items = items;
    this.selected = 0;
    if (!items.length) return this.hide();
    this.render();
    this.el.dataset.show = "true";
    // aria-expanded isn't allowed on the editor's textbox role; these are.
    this.view.dom.setAttribute("aria-controls", this.id);
    this.place(at);
  }

  /** Focus left the editor: hide, and drop an answer still on its way. */
  blur(): void {
    this.seq++;
    this.shownFor = "";
    this.hide();
  }

  hide(): void {
    if (!this.visible) return;
    this.el.dataset.show = "false";
    this.shownFor = "";
    this.view.dom.removeAttribute("aria-activedescendant");
    this.view.dom.removeAttribute("aria-controls");
  }

  /** Under the `[[`, kept inside the window. */
  private place(at: At): void {
    let c: { left: number; bottom: number };
    try {
      c = this.view.coordsAtPos(at.start + at.q.open);
    } catch {
      return;
    }
    const width = this.el.offsetWidth || 240;
    const left = Math.max(8, Math.min(c.left, window.innerWidth - width - 8));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${c.bottom + 4}px`;
  }

  private render(): void {
    this.el.replaceChildren();
    this.items.forEach((s, i) => {
      const shown = displayOf(s);
      const row = document.createElement("div");
      row.className = "milkdown-slash-item";
      row.id = `${this.id}-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.selected));
      if (i === this.selected) row.dataset.selected = "true";
      const icon = document.createElement("span");
      icon.className = "slash-icon";
      icon.textContent = ICONS[s.kind];
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "slash-label";
      label.dir = "auto";
      label.textContent = shown.label;
      row.append(icon, label);
      if (shown.detail) {
        const detail = document.createElement("span");
        detail.className = "slash-detail";
        detail.dir = "auto";
        detail.textContent = shown.detail;
        detail.style.cssText = "margin-inline-start:auto;font-size:11px;color:hsl(var(--fg-muted));max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        row.append(detail);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pick(i);
      });
      this.el.appendChild(row);
    });
    this.view.dom.setAttribute("aria-activedescendant", `${this.id}-${this.selected}`);
  }

  private move(delta: number): void {
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.render();
    this.el.querySelector<HTMLElement>(`[data-selected="true"]`)?.scrollIntoView?.({ block: "nearest" });
  }

  pick(i: number): void {
    const s = this.items[i];
    const at = contextAt(this.view);
    this.hide();
    if (!s || !at) return;
    const e = wikiEdit(at.q, at.before, at.after, s);
    const tr = this.view.state.tr.insertText(e.insert, at.start + e.from, at.start + e.to);
    tr.setSelection(TextSelection.create(tr.doc, Math.min(at.start + e.caret, tr.doc.content.size)));
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
    if (s.kind === "create" && s.createPath) void createLinkedNote(s.createPath);
  }

  /** Keys while the menu is open; false lets the editor have the key. */
  key(e: KeyboardEvent): boolean {
    // The slash menu (`[[folder/`) may have taken the key already.
    if (!this.visible || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      this.move(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      this.pick(this.selected);
      return true;
    }
    if (e.key === "Escape") {
      const at = contextAt(this.view);
      this.dismissed = at ? at.start + at.q.open : null;
      this.hide();
      return true;
    }
    return false;
  }

  destroy(): void {
    this.seq++;
    this.el.remove();
  }
}

/** The ProseMirror plugin: watches the caret, shows the menu, takes its keys. */
export function wysiwygWikiComplete(): Plugin {
  const menus = new WeakMap<EditorView, WikiMenu>();
  return new Plugin({
    key: wikiCompleteKey,
    view(view) {
      const menu = new WikiMenu(view);
      menus.set(view, menu);
      menu.update(view);
      return {
        update: (v) => menu.update(v),
        destroy: () => {
          menu.destroy();
          menus.delete(view);
        },
      };
    },
    props: {
      handleKeyDown: (view, e) => menus.get(view)?.key(e) ?? false,
      handleDOMEvents: {
        blur: (view) => {
          menus.get(view)?.blur();
          return false;
        },
        // Back in the editor with the caret still in a `[[`: offer again.
        focus: (view) => {
          menus.get(view)?.update(view);
          return false;
        },
      },
    },
  });
}
