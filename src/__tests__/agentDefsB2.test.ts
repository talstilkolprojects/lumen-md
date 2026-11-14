import { describe, it, expect } from "vitest";
import { chunkMarkdown, checkTranslation, expectedScript } from "../agents/defs";

describe("translator helpers", () => {
  it("maps language names and codes to scripts", () => {
    expect(expectedScript("עברית")).toBe("hebrew");
    expect(expectedScript("he")).toBe("hebrew");
    expect(expectedScript("Russian")).toBe("cyrillic");
    expect(expectedScript("日本語")).toBe("cjk");
    expect(expectedScript("Français")).toBe("latin");
    expect(expectedScript("Klingon")).toBeNull();
  });

  it("chunks at blank lines, never inside a fence, and keeps short text whole", () => {
    expect(chunkMarkdown("short")).toEqual(["short"]);
    const text = "a\n\n```\n" + "line\n".repeat(50) + "```\n\n" + "b\n".repeat(5) + "\n" + "c\n".repeat(5);
    const chunks = chunkMarkdown(text, 100);
    expect(chunks.join("\n")).toBe(text);
    for (const c of chunks) expect((c.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("checks structure and script", () => {
    expect(checkTranslation("שלום [a](https://x)", "hello [a](https://x)", "he")).toEqual({ ok: true });
    expect(checkTranslation("hello", "hello", "he").ok).toBe(false);
    expect(checkTranslation("", "x", "en").ok).toBe(false);
    expect(checkTranslation("x ![i](a.png)", "y ![i](b.png)", "en").ok).toBe(false);
    // Hebrew source to English: the output must be Latin.
    expect(checkTranslation("שלום עולם", "שלום עולם", "English").ok).toBe(false);
    expect(checkTranslation("hello world", "שלום עולם", "English")).toEqual({ ok: true });
    // An unknown target language: structure only.
    expect(checkTranslation("whatever", "source", "Klingon")).toEqual({ ok: true });
  });
});
