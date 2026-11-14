/**
 * Plan 1.7 step 5 — the model-credits section of the Credits dialog shows,
 * for each model, its name, licence (linked), source, attribution and what
 * the licence requires, with the Hebrew models (ivrit.ai, Dicta) first.
 */
import { describe, expect, it } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { ModelCreditsSection } from "../ui/CreditsDialog";
import { modelCredits } from "../ai/modelCredits";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("model credits section", () => {
  it("lists every model with licence, source, attribution and requirement; Hebrew first", async () => {
    const credits = modelCredits();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ModelCreditsSection, { credits })));
    const items = [...host.querySelectorAll<HTMLElement>('[data-testid="model-credit"]')];
    expect(items.length).toBe(credits.length);
    const ivrit = host.querySelector<HTMLElement>('[data-model="ivrit-ai/zipformer2-66m-streaming-he"]')!;
    expect(ivrit.textContent).toContain("zipformer2-66m-streaming-he");
    expect(ivrit.textContent).toContain("CC BY 4.0: the creator is credited");
    expect(ivrit.querySelector<HTMLAnchorElement>('a[href="https://creativecommons.org/licenses/by/4.0/"]')).not.toBeNull();
    expect(ivrit.querySelector<HTMLAnchorElement>('a[href="https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he"]')).not.toBeNull();
    const lists = host.querySelectorAll("ul");
    expect(lists[0].textContent).toMatch(/ivrit/);
    expect(lists[0].textContent).toMatch(/DictaLM/);
    expect(lists[1].textContent).not.toMatch(/ivrit|DictaLM/);
    const llama = items.find((li) => li.dataset.model === "Llama-3.2-1B-Instruct")!;
    expect(llama.textContent).toContain("Built with Llama");
    await act(async () => root.unmount());
  });
});
