/**
 * Smoke tests for the grammar-check editor extension. The full
 * CodeMirror integration is too jsdom-heavy to drive faithfully; we
 * pin the factory contract:
 *   - returns a non-empty Extension (ViewPlugin) so it can be plugged
 *     into a Compartment
 *   - the `setGrammarDebounce` helper clamps to a sane minimum
 */

import { describe, it, expect, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { grammarExtension, setGrammarDebounce } from "../editor/grammarExtension";
import { DICTIONARY_CHANGED_EVENT } from "../ai/hebrewSpellService";

const checks = vi.hoisted(() => ({ n: 0, gate: null as null | Promise<void> }));
vi.mock("../ai/hebrewSpellService", async (orig) => ({
  ...(await orig<object>()),
  checkByLanguage: vi.fn(async () => {
    checks.n++;
    await checks.gate;
    return [];
  }),
}));

describe("grammarExtension", () => {
  it("returns a ViewPlugin (non-empty Extension)", () => {
    const ext = grammarExtension();
    const isEmpty = Array.isArray(ext) && (ext as unknown[]).length === 0;
    expect(isEmpty).toBe(false);
  });

  it("accepts an options bag (language + onMatches callback)", () => {
    const ext = grammarExtension({
      language: "fr",
      onMatches: () => {},
    });
    expect(ext).toBeTruthy();
  });
});

describe("setGrammarDebounce", () => {
  it("clamps below-200ms inputs up to the 200ms floor (no contract violation)", () => {
    // Implementation uses Math.max(200, ...) — calling with 50 should not throw.
    expect(() => setGrammarDebounce(50)).not.toThrow();
  });

  it("accepts realistic debounce values", () => {
    expect(() => setGrammarDebounce(800)).not.toThrow();
    expect(() => setGrammarDebounce(3000)).not.toThrow();
  });
});

describe("dictionary changes", () => {
  it("re-checks the unchanged document after the Hebrew dictionary is installed or removed", async () => {
    vi.useFakeTimers();
    try {
      setGrammarDebounce(200);
      const view = new EditorView({ state: EditorState.create({ doc: "שלום עולם, זו פסקה בעברית שאינה משתנה בכלל.", extensions: [grammarExtension()] }), parent: document.body });
      await vi.advanceTimersByTimeAsync(300);
      expect(checks.n).toBe(1);
      window.dispatchEvent(new Event(DICTIONARY_CHANGED_EVENT));
      await vi.advanceTimersByTimeAsync(300);
      expect(checks.n).toBe(2);
      view.destroy();
      window.dispatchEvent(new Event(DICTIONARY_CHANGED_EVENT));
      await vi.advanceTimersByTimeAsync(300);
      expect(checks.n).toBe(2);
    } finally {
      vi.useRealTimers();
      setGrammarDebounce(1500);
    }
  });

  it("a dictionary change during an in-flight check runs again once it ends (#257 review)", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    checks.gate = new Promise<void>((r) => (release = r));
    const base = checks.n;
    try {
      setGrammarDebounce(200);
      const view = new EditorView({ state: EditorState.create({ doc: "שלום עולם, זו פסקה בעברית שאינה משתנה בכלל.", extensions: [grammarExtension()] }), parent: document.body });
      await vi.advanceTimersByTimeAsync(300);
      expect(checks.n).toBe(base + 1); // in flight, held by the gate
      window.dispatchEvent(new Event(DICTIONARY_CHANGED_EVENT));
      await vi.advanceTimersByTimeAsync(300);
      expect(checks.n).toBe(base + 1); // skipped while in flight…
      release();
      checks.gate = null;
      await vi.advanceTimersByTimeAsync(300);
      expect(checks.n).toBe(base + 2); // …and run again when it ended
      view.destroy();
    } finally {
      checks.gate = null;
      vi.useRealTimers();
      setGrammarDebounce(1500);
    }
  });
});
