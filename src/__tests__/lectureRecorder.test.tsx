/**
 * Plan W5.13 — the lecture recorder: start, tap "Important!" (and the space
 * bar), stop; the taps reach processing as seconds into the recording, and
 * the note is opened.
 */
import { describe, it, expect } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { LectureRecorder, type RecorderDeps } from "../student/LectureRecorder";
import { t } from "../i18n";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("lecture recorder", () => {
  it("records, marks moments by button and space bar, processes and opens the note", async () => {
    let clock = 1000;
    const processed: Array<{ markers: number[]; title: string; durationMs: number }> = [];
    const opened: string[] = [];
    const deps: RecorderDeps = {
      start: async () => ({ stop: async () => ({ audio: new Blob(["x"], { type: "audio/webm" }), durationMs: 60_000 }), cancel: () => {} }),
      process: async (_a, o) => (processed.push(o), { path: "Lectures/x.md", cards: 2, important: 3 }),
      open: (p) => void opened.push(p),
      now: () => clock,
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(LectureRecorder, { onClose: () => {}, deps })));
    const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const input = host.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Biology 3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => q("lecture-start").click());
    clock += 12_300;
    await act(async () => q("lecture-mark").click());
    clock += 30_000;
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })));
    expect(q("lecture-marks").textContent).toBe("Marked moments: 2");
    await act(async () => q("lecture-stop").click());
    expect(processed).toEqual([{ durationMs: 60_000, markers: [12.3, 42.3], title: "Biology 3" }]);
    expect(opened).toEqual(["Lectures/x.md"]);
    expect(q("lecture-message").textContent).toBe("Done: 3 important sentences, 2 cards.");
    await act(async () => root.unmount());
  });

  it("says which summary the lecture got: checked or extractive (W10.C9)", async () => {
    let clock = 1000;
    const processed: Array<{ markers: number[]; title: string; durationMs: number }> = [];
    const opened: string[] = [];
    const deps: RecorderDeps = {
      start: async () => ({ stop: async () => ({ audio: new Blob(["x"], { type: "audio/webm" }), durationMs: 60_000 }), cancel: () => {} }),
      process: async (_a, o) => (processed.push(o), { path: "Lectures/x.md", cards: 2, important: 3, summary: "extractive" as const }),
      open: (p) => void opened.push(p),
      now: () => clock,
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(LectureRecorder, { onClose: () => {}, deps })));
    const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const input = host.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Biology 3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => q("lecture-start").click());
    clock += 12_300;
    await act(async () => q("lecture-mark").click());
    clock += 30_000;
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })));
    expect(q("lecture-marks").textContent).toBe("Marked moments: 2");
    await act(async () => q("lecture-stop").click());
    expect(processed).toEqual([{ durationMs: 60_000, markers: [12.3, 42.3], title: "Biology 3" }]);
    expect(opened).toEqual(["Lectures/x.md"]);
    expect(q("lecture-message").textContent).toMatch(/^Done: 3 important sentences, 2 cards\. Extractive summary: /);
    await act(async () => root.unmount());
  });

  it("says why the microphone did not start", async () => {
    const deps: RecorderDeps = { start: async () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")), process: async () => ({ path: "", cards: 0, important: 0 }), open: () => {}, now: () => 0 };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(LectureRecorder, { onClose: () => {}, deps })));
    await act(async () => host.querySelector<HTMLElement>('[data-testid="lecture-start"]')!.click());
    // The reason in words (explainError: the browser refused), not the DOMException's own text.
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(`The microphone could not start: ${t("error.permission")}`);
    await act(async () => root.unmount());
  });
});
