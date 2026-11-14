/**
 * W7.3 in a DOM: the backlinks list (search, sort, fold), the image edge's
 * double-click reset, and the copy handler's two clipboard types.
 */
import { describe, it, expect } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import BacklinksList from "../ui/BacklinksList";
import { attachImageResize } from "../renderer/imageSize";
import { copySelectionWithHtml } from "../editor/copyEvents";
import type { EditorView } from "@codemirror/view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hits = [
  { fromPath: "b/בית.md", fromName: "בית", snippet: "קישור [[x]] בבית", offset: 4 },
  { fromPath: "a/Alpha.md", fromName: "Alpha", snippet: "see [[x]] here", offset: 3 },
  { fromPath: "a/Alpha.md", fromName: "Alpha", snippet: "again [[x]]", offset: 30 },
];

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("BacklinksList", () => {
  it("groups, searches, folds and opens", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const opened: string[] = [];
    const root = createRoot(host);
    await act(async () => root.render(createElement(BacklinksList, { hits, onOpen: (p: string) => opened.push(p) })));
    const groups = () => [...host.querySelectorAll('[data-testid="backlink-group"]')];
    expect(groups().length).toBe(2);
    expect(groups()[0].textContent).toContain("Alpha");
    expect(groups()[0].querySelectorAll("li").length).toBe(2);
    // Fold the first note: its hits go, the header stays.
    await act(async () => (groups()[0].querySelector("button") as HTMLButtonElement).click());
    expect(groups()[0].querySelectorAll("li").length).toBe(0);
    expect(groups()[0].querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    // Search by snippet text.
    await act(async () => setValue(host.querySelector('[data-testid="backlinks-search"]') as HTMLInputElement, "בבית"));
    expect(groups().length).toBe(1);
    expect(groups()[0].textContent).toContain("בית");
    await act(async () => (groups()[0].querySelectorAll(":scope ul li button")[0] as HTMLButtonElement).click());
    expect(opened).toEqual(["b/בית.md"]);
    await act(async () => setValue(host.querySelector('[data-testid="backlinks-search"]') as HTMLInputElement, "nothing-here"));
    expect(groups().length).toBe(0);
    expect(host.textContent).toContain("nothing-here");
    await act(async () => root.unmount());
    host.remove();
  });
});

describe("image edge double-click", () => {
  it("calls onReset with the image's offset and target", () => {
    const root = document.createElement("div");
    const img = document.createElement("img");
    img.setAttribute("data-md-offset", "12");
    img.setAttribute("data-md-target", "a.png");
    img.style.cssText = "display:block;width:100px;height:40px";
    img.style.width = "200px";
    root.append(img);
    document.body.append(root);
    const resets: Array<[number, string]> = [];
    const off = attachImageResize(root, () => undefined, (o, t) => resets.push([o, t]));
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: r.right - 2, clientY: r.top + 2 }));
    expect(resets).toEqual([[12, "a.png"]]);
    expect(img.style.width).toBe("");
    off();
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: r.right - 2, clientY: r.top + 2 }));
    expect(resets.length).toBe(1);
    root.remove();
  });
});

describe("copy handler", () => {
  function fakeView(doc: string, from: number, to: number) {
    const dispatched: unknown[] = [];
    const view = {
      state: { selection: { ranges: [{ from, to, empty: from === to }] }, sliceDoc: (a: number, b: number) => doc.slice(a, b), readOnly: false },
      dispatch: (tr: unknown) => dispatched.push(tr),
    };
    return { view: view as unknown as EditorView, dispatched };
  }
  function fakeEvent() {
    const data: Record<string, string> = {};
    let prevented = false;
    const event = { clipboardData: { setData: (k: string, v: string) => void (data[k] = v) }, preventDefault: () => void (prevented = true) };
    return { event: event as unknown as ClipboardEvent, data, prevented: () => prevented };
  }
  it("puts Markdown and HTML on the clipboard; cut also deletes", () => {
    const doc = "# כותרת\n\n**שלום** world";
    const { view, dispatched } = fakeView(doc, 0, doc.length);
    const e = fakeEvent();
    expect(copySelectionWithHtml(e.event, view, false)).toBe(true);
    expect(e.prevented()).toBe(true);
    expect(e.data["text/plain"]).toBe(doc);
    expect(e.data["text/html"]).toContain('<h1 dir="rtl">כותרת</h1>');
    expect(e.data["text/html"]).toContain("<strong>שלום</strong>");
    expect(dispatched.length).toBe(0);
    const c = fakeEvent();
    expect(copySelectionWithHtml(c.event, view, true)).toBe(true);
    expect(dispatched.length).toBe(1);
  });
  it("leaves an empty selection to CodeMirror", () => {
    const { view } = fakeView("abc", 1, 1);
    const e = fakeEvent();
    expect(copySelectionWithHtml(e.event, view, false)).toBe(false);
    expect(e.prevented()).toBe(false);
  });
});
