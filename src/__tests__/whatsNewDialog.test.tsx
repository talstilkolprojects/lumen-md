/** Plan 14.6 — the "What's new" dialog: the notes rendered, the untranslated notice, closing. */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { WhatsNewDialog } from "../whatsNew/WhatsNewDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(notes: Parameters<typeof WhatsNewDialog>[0]["notes"]) {
  let closed = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (md: string) => createElement("pre", { "data-testid": "rendered" }, md);
  await act(async () => root.render(createElement(WhatsNewDialog, { notes, version: "1.2.0", render, onClose: () => closed++ })));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return { host, root, closed: () => closed };
}

describe("What's new dialog (14.6)", () => {
  it("shows the version's notes; says when they're not translated; Esc and the button close", async () => {
    const m = await mount({ version: "1.2.0", date: "2026-11-10", markdown: "### חדש\n\n- x", translated: false });
    expect(m.host.querySelector('[data-testid="whats-new"]')!.getAttribute("data-version")).toBe("1.2.0");
    expect(m.host.querySelector('[data-testid="rendered"]')!.textContent).toBe("### חדש\n\n- x");
    expect(m.host.textContent).toContain("aren't translated yet");
    expect(m.host.textContent).toContain("2026-11-10");
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    act(() => (m.host.querySelector('[data-testid="whats-new-close"]') as HTMLButtonElement).click());
    expect(m.closed()).toBe(2);
    act(() => m.root.unmount());
  });

  it("no notes for this version: says so", async () => {
    const m = await mount(null);
    expect(m.host.textContent).toContain("There are no release notes for this version.");
    expect(m.host.textContent).not.toContain("translated");
    act(() => m.root.unmount());
  });
});
