/**
 * Plan W2.17 — the presentation: every slide rendered once, changing slide
 * under 50 ms, arrow keys in the deck's direction, speaker notes never on
 * the slide, Esc ends it; and the presenter view follows it over the
 * BroadcastChannel and moves it.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Presentation, type SlideView } from "../slides/Presentation";
import PresenterView from "../slides/PresenterView";
import { noteToDeck } from "../slides/deck";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deck = noteToDeck(Array.from({ length: 30 }, (_, i) => `## שקף ${i + 1}\n\nתוכן ${i + 1}\n\nהערות: הערה ${i + 1}`).join("\n\n"));
const views: SlideView[] = deck.slides.map((s) => ({ title: s.title, notes: s.notes, dir: s.dir, content: createElement("div", null, createElement("h2", null, s.title), createElement("p", null, s.markdown.split("\n").pop())) }));

function mount(onClose = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Presentation, { title: deck.title, dir: deck.dir, slides: views, onClose })));
  return { root, host, el: () => document.querySelector<HTMLElement>('[data-testid="slides"]')! };
}
const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
const shown = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="slide"]')).filter((s) => !s.hidden);

describe("presentation (W2.17)", () => {
  it("30 Hebrew slides: all rendered once, one shown; ← is next in RTL; each change < 50 ms", () => {
    const { root, host, el } = mount();
    expect(document.querySelectorAll('[data-testid="slide"]')).toHaveLength(30);
    expect(shown()).toHaveLength(1);
    expect(el().getAttribute("dir")).toBe("rtl");
    expect(el().textContent).not.toContain("הערה 1");
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      key("ArrowLeft");
      times.push(Number(el().dataset.switchMs));
    }
    expect(el().dataset.index).toBe("10");
    expect(shown()[0].textContent).toContain("שקף 11");
    key("ArrowRight");
    expect(el().dataset.index).toBe("9");
    key("End");
    expect(el().dataset.index).toBe("29");
    key(" ");
    expect(el().dataset.index).toBe("29");
    key("Home");
    expect(document.querySelector('[data-testid="slides-count"]')!.textContent).toBe("1 / 30");
    expect(Math.max(...times)).toBeLessThan(50);
    act(() => root.unmount());
    host.remove();
  });

  it("Esc ends the show", () => {
    let closed = 0;
    const { root, host } = mount(() => closed++);
    key("Escape");
    expect(closed).toBe(1);
    act(() => root.unmount());
    host.remove();
  });

  it("the presenter view gets the slides and notes, follows the show and moves it", async () => {
    const { root, host, el } = mount();
    const pHost = document.createElement("div");
    document.body.appendChild(pHost);
    const pRoot = createRoot(pHost);
    act(() => pRoot.render(createElement(PresenterView)));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)));
      return ok();
    };
    expect(await until(() => !!document.querySelector('[data-testid="presenter"]'))).toBe(true);
    expect(document.querySelector('[data-testid="presenter-notes"]')!.textContent).toBe("הערה 1");
    key("ArrowLeft");
    expect(await until(() => document.querySelector('[data-testid="presenter"]')?.getAttribute("data-index") === "1")).toBe(true);
    expect(document.querySelector('[data-testid="presenter-notes"]')!.textContent).toBe("הערה 2");
    const next = Array.from(pHost.querySelectorAll("button")).find((b) => b.textContent === "Next slide")!;
    act(() => next.click());
    expect(await until(() => el().dataset.index === "2")).toBe(true);
    act(() => pRoot.unmount());
    act(() => root.unmount());
    host.remove();
    pHost.remove();
  });
});
