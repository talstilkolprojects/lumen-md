/**
 * Plan W2.16 — the cite dialog: inserting a citation takes fewer than 3
 * keystrokes after the shortcut (Enter cites the last-used source; ↓ Enter
 * the next), search, locator, in-text form.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { CiteDialog, citationText } from "../citations/CiteDialog";
import type { LibraryItem } from "../citations/library";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (key: string, family: string, year: string, title: string): LibraryItem => ({ key, origin: "bibtex", path: "refs.bib", record: { type: "book", authors: [{ family }], year, title } });
const LIB = [item("austen1813", "Austen", "1813", "Pride and Prejudice"), item("darwin1859", "Darwin", "1859", "On the Origin of Species"), item("כהן2020", "כהן", "2020", "על קריאה")];

async function mount() {
  const inserted: string[] = [];
  let closed = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(CiteDialog, { load: async () => LIB, onInsert: (t: string) => inserted.push(t), onClose: () => closed++ })));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  const dialog = host.querySelector<HTMLElement>('[data-testid="cite-dialog"]')!;
  const key = (k: string, extra: KeyboardEventInit = {}) => act(() => void (document.activeElement ?? dialog).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })));
  return { host, root, inserted, closedCount: () => closed, key, dialog };
}

describe("cite dialog (W2.16)", () => {
  it("Enter right away cites the most recently used source (shortcut + 1 keystroke)", async () => {
    localStorage.setItem("lumen.cite.recent", JSON.stringify(["darwin1859"]));
    const m = await mount();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("cite-search");
    expect(m.host.querySelector('[data-testid="cite-item"]')!.getAttribute("data-key")).toBe("darwin1859");
    m.key("Enter");
    expect(m.inserted).toEqual(["[@darwin1859]"]);
    expect(m.closedCount()).toBe(1);
    expect(JSON.parse(localStorage.getItem("lumen.cite.recent")!)[0]).toBe("darwin1859");
    act(() => m.root.unmount());
  });

  it("↓ then Enter cites the next one (shortcut + 2); search narrows; Hebrew finds Hebrew", async () => {
    localStorage.setItem("lumen.cite.recent", JSON.stringify(["darwin1859"]));
    const m = await mount();
    m.key("ArrowDown");
    m.key("Enter");
    expect(m.inserted).toEqual(["[@austen1813]"]);
    act(() => m.root.unmount());

    const m2 = await mount();
    const search = m2.host.querySelector<HTMLInputElement>('[data-testid="cite-search"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(search, "כהן");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...m2.host.querySelectorAll('[data-testid="cite-item"]')].map((e) => e.getAttribute("data-key"))).toEqual(["כהן2020"]);
    m2.key("Enter", { shiftKey: true });
    expect(m2.inserted).toEqual(["@כהן2020"]);
    act(() => m2.root.unmount());
  });

  it("a locator goes into the citation; Esc closes without inserting", async () => {
    const m = await mount();
    const loc = m.host.querySelector<HTMLInputElement>('[data-testid="cite-locator"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(loc, "p. 10");
      loc.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => loc.focus());
    m.key("Enter");
    expect(m.inserted[0]).toMatch(/^\[@[^\]]+, p\. 10\]$/);
    act(() => m.root.unmount());
    const m2 = await mount();
    m2.key("Escape");
    expect([m2.inserted.length, m2.closedCount()]).toEqual([0, 1]);
    act(() => m2.root.unmount());
    expect(citationText("k", "", true)).toBe("@k");
    expect(citationText("k", "chap. 2", true)).toBe("@k [chap. 2]");
  });
});
