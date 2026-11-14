import { describe, it, expect, afterEach } from "vitest";
import { createRef } from "react";
// @ts-expect-error — plain .mjs script without type declarations
import { findTestSurface } from "../../scripts/check-test-surface.mjs";
import { startAgentReview } from "../agents/reviewBridge";
import type { EditorHandle } from "../editor/Editor";

type Hit = { rule: string };
const rules = (text: string): string[] => (findTestSurface(text) as Hit[]).map((h) => h.rule);
type Surface = { __lumen?: { agentReview?: { stage: unknown; withdrawRun: unknown } } };

describe("window.__lumen.agentReview only in development and tests (plan W1.31)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it("exists under vitest (import.meta.env.DEV) and goes away on stop", () => {
    expect(import.meta.env.DEV).toBe(true);
    stop = startAgentReview({ editorRef: createRef<EditorHandle>(), onPending: () => {}, openPanel: () => {} });
    const surface = window as unknown as Surface;
    expect(typeof surface.__lumen?.agentReview?.stage).toBe("function");
    expect(typeof surface.__lumen?.agentReview?.withdrawRun).toBe("function");
    stop();
    stop = undefined;
    expect(surface.__lumen?.agentReview).toBeUndefined();
  });

  it("the dist gate finds the surface in minified code", () => {
    expect(rules(`(e.__lumen??={}).agentReview={stage:t,withdrawRun:n}`)).toEqual(["agentReview-property", "withdrawRun-member"]);
    expect(rules(`delete e.__lumen?.agentReview}`)).toEqual(["agentReview-property"]);
  });

  it("the dist gate leaves the i18n keys and other names alone", () => {
    expect(rules(`t("agentReview.title"),{"agentReview.badge":"x"},n.agentReviewPending,a.agentReview.x`)).toEqual([]);
  });
});
