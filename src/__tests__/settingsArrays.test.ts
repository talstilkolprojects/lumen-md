// Review t5 (L2): app fields classed `json` that hold arrays could be exported but never imported.
// Adopted with the fix: they are `list` (an array of strings, bounded).
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../settings/schema";
import { exportSettings, importSettings } from "../settings/io";

describe("settings round trip (review t5)", () => {
  it("an exported enabledSnippets / mobileToolbar comes back on import", () => {
    const state: Record<string, unknown> = { enabledSnippets: ["dark-headings.css"], mobileToolbar: ["bold", "italic"], showLocalGraph: true };
    const patched: Record<string, unknown> = {};
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    const file = exportSettings({ getApp: () => state, applyApp: () => {}, storage });
    expect(Object.keys(file.app).sort()).toEqual(["enabledSnippets", "mobileToolbar", "showLocalGraph"]);
    const r = importSettings(file, { getApp: () => ({}), applyApp: (p) => Object.assign(patched, p), storage });
    expect(r.skipped).toEqual([]);
    expect(patched).toEqual(state);
  });
  it("no app entry of type json is an array in the store's defaults; the arrays are `list`", async () => {
    const { useAppStore } = await import("../store/useStore");
    const defaults = useAppStore.getState() as unknown as Record<string, unknown>;
    const jsonArrays = SETTINGS.filter((e) => e.store === "app" && e.type === "json" && Array.isArray(defaults[e.id])).map((e) => e.id);
    expect(jsonArrays).toEqual([]);
    expect(SETTINGS.filter((e) => e.type === "list").map((e) => e.id).sort()).toEqual(["enabledSnippets", "mobileToolbar"]);
  });

  it("a `list` import is bounded: not an array, a non-string item or too many items is skipped", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    for (const bad of [{ a: 1 }, "bold", [1, 2], [""], Array.from({ length: 65 }, (_, i) => `a${i}`), ["x".repeat(257)]]) {
      const r = importSettings({ format: exportSettings({ getApp: () => ({}), applyApp: () => {}, storage }).format, version: 1, app: { mobileToolbar: bad }, local: {} }, { getApp: () => ({}), applyApp: () => {}, storage });
      expect(r.skipped, JSON.stringify(bad).slice(0, 40)).toEqual(["mobileToolbar"]);
    }
  });
});
