/**
 * Gemini model defaults: Google shut down Gemini 1.5 and 2.0, so a saved
 * choice of a retired model falls back to the current default instead of
 * failing every request.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PROVIDER_DEFAULT_MODELS, LIGHT_MODELS, effectiveModel, isRetiredGeminiModel } from "../ai/llm";
import { getGeminiModel } from "../ai/geminiProvider";
import { costOf } from "../ai/usage";

describe("Gemini models", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to current models, not retired ones", () => {
    expect(isRetiredGeminiModel(PROVIDER_DEFAULT_MODELS.gemini)).toBe(false);
    expect(isRetiredGeminiModel(LIGHT_MODELS.gemini!)).toBe(false);
  });

  it("recognizes the shut-down families only", () => {
    for (const m of ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash", "gemini-2.0-flash-lite"]) {
      expect(isRetiredGeminiModel(m), m).toBe(true);
    }
    for (const m of ["gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
      expect(isRetiredGeminiModel(m), m).toBe(false);
    }
  });

  it("ignores a saved retired model in the request and in metering", () => {
    localStorage.setItem("lumen.ai.model.gemini", "gemini-1.5-flash");
    expect(getGeminiModel({})).toBe(PROVIDER_DEFAULT_MODELS.gemini);
    expect(effectiveModel("gemini")).toBe(PROVIDER_DEFAULT_MODELS.gemini);
  });

  it("keeps a saved current model", () => {
    localStorage.setItem("lumen.ai.model.gemini", "gemini-2.5-pro");
    expect(getGeminiModel({})).toBe("gemini-2.5-pro");
    expect(effectiveModel("gemini")).toBe("gemini-2.5-pro");
  });

  it("prices the new defaults", () => {
    const flash = costOf({ provider: "gemini", model: "gemini-3.8-flash", inputTokens: 1e6, outputTokens: 1e6 });
    expect(flash).toBeCloseTo(0.75 + 3.75, 6);
    const lite = costOf({ provider: "gemini", model: "gemini-3.5-flash-lite", inputTokens: 1e6, outputTokens: 1e6 });
    expect(lite).toBeCloseTo(0.3 + 2.5, 6);
  });

  it("prices Gemini 3.x cache reads at 10% of input, as the pricing page lists", () => {
    const cached = (model: string) => costOf({ provider: "gemini", model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6 });
    expect(cached("gemini-3.8-flash")).toBeCloseTo(0.075, 6);
    expect(cached("gemini-3.6-flash")).toBeCloseTo(0.075, 6);
    expect(cached("gemini-3.5-flash-lite")).toBeCloseTo(0.03, 6);
    expect(cached("gemini-3.1-flash-lite")).toBeCloseTo(0.025, 6);
  });
});
