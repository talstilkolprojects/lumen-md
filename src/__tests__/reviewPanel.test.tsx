/**
 * Plan W3.3 — the daily review screen over a real vault: it opens from
 * `.lumen/review.json` in under 300 ms, shows today's cards, reveals and
 * rates them with the keyboard, and saves the schedule back to the file;
 * the vault's question::answer lines join as new cards.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ReviewPanel } from "../srs/ReviewPanel";
import { emptyReviewFile, parseReviewFile, rate, REVIEW_PATH, serializeReviewFile, syncSources, type Source } from "../srs/cards";
import { fsrs } from "../srs/fsrs";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function until<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const T0 = new Date("2026-01-05T09:00:00Z");
const NOW = new Date("2026-02-05T09:00:00Z");
const src = (i: number): Source => ({ id: `qa:study.md#${i}`, kind: "qa", front: `Question ${i}?`, back: `Answer ${i}`, link: "study.md", source: "study.md" });

describe("daily review UI (W3.3)", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(async () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    let file = syncSources(emptyReviewFile(), [src(1), src(2), src(3)], T0);
    for (const i of [1, 2, 3]) file = rate(file, `qa:study.md#${i}`, 4, T0, fsrs());
    await writeWorkspaceFile(REVIEW_PATH, serializeReviewFile(file));
    await writeWorkspaceFile("study.md", "# Study\n\nWhat is FSRS? :: A spacing algorithm\n");
  });

  it("opens fast, reveals and rates with keys, saves the schedule, adds the vault's new cards", async () => {
    const opened = performance.now();
    await act(async () => root.render(createElement(ReviewPanel, { onClose: () => undefined, opened, now: () => NOW })));
    const panel = await until(() => host.querySelector<HTMLElement>('[data-testid="review-panel"][data-open-ms]'));
    expect(Number(panel.dataset.openMs)).toBeLessThan(300);
    const card = await until(() => host.querySelector('[data-testid="review-card"]'));
    expect(card.textContent).toContain("Question 1?");
    const key = async (k: string) => act(async () => panel.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
    await key(" ");
    expect(host.querySelector(".srs-back")?.textContent).toBe("Answer 1");
    await key("3");
    await until(() => host.querySelector('[data-testid="review-card"]')?.textContent?.includes("Question 2?"));
    await key(" ");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="review-rate-1"]')!.click());
    await until(async () => {
      const f = parseReviewFile(await readWorkspaceFile(REVIEW_PATH));
      return f && f.cards["qa:study.md#1"].card.reps === 2 && f.cards["qa:study.md#2"].card.state === "relearning" && f.cards[Object.keys(f.cards).find((k) => k.startsWith("qa:study.md#") && f.cards[k].front === "What is FSRS?") ?? ""];
    });
    const f = parseReviewFile(await readWorkspaceFile(REVIEW_PATH))!;
    expect(f.cards["qa:study.md#1"].card.due > NOW.toISOString()).toBe(true);
    expect(f.cards["qa:study.md#1"].log.at(-1)).toEqual({ at: NOW.toISOString(), rating: 3 });
    // The demo cards weren't in the vault: kept, marked gone, not reviewed.
    expect(f.cards["qa:study.md#3"].gone).toBe(true);
    await act(async () => root.unmount());
  });
});
