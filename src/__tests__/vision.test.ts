/** T31 — OCR text cleanup, alt text rules, Markdown rewriting, vision model pick. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanOcrText, meaningfulText } from "../ai/ocr";

const ocr = vi.hoisted(() => ({ result: { text: "", confidence: 0 } }));
vi.mock("../ai/ocr", async (orig) => ({
  ...(await orig<typeof import("../ai/ocr")>()),
  ocrImage: vi.fn(async () => ocr.result),
}));
import { altIsPlaceholder, escapeAlt, escapeTitle, imageText, imagesNeedingAlt, visionModel, withImageText } from "../ai/vision";

describe("OCR helpers", () => {
  it("cleans noise and keeps Hebrew and English lines", () => {
    expect(cleanOcrText("  שלום   עולם \n\n|\n Hello  world \n ~ \n")).toBe("שלום עולם\nHello world");
  });
  it("needs enough letters and confidence to count as text", () => {
    expect(meaningfulText({ text: "סיכום הפגישה של יום שלישי", confidence: 80 })).toBe(true);
    expect(meaningfulText({ text: "ab", confidence: 95 })).toBe(false);
    expect(meaningfulText({ text: "סיכום הפגישה של יום שלישי", confidence: 30 })).toBe(false);
  });
});

describe("image text", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("an image of text gets its first line as alt and the full text as title", async () => {
    ocr.result = { text: "סיכום פגישה\nההשקה נדחתה ליום שלישי", confidence: 88 };
    const r = await imageText(new Blob(["x"]), "he");
    expect(r).toMatchObject({ source: "ocr", alt: "תמונה עם הטקסט: סיכום פגישה" });
    expect(r.title).toContain("ההשקה נדחתה");
  });

  it("no text and no local vision model → no invented alt text", async () => {
    ocr.result = { text: "", confidence: 0 };
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await imageText(new Blob(["x"]), "en")).toEqual({ alt: "", source: "none" });
  });

  it("falls back to a local vision model when Ollama has one", async () => {
    ocr.result = { text: "", confidence: 0 };
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5vl:7b" }] }));
      return new Response(JSON.stringify({ message: { content: "A cat on a red sofa." } }));
    });
    expect(await visionModel()).toBe("qwen2.5vl:7b");
    expect(await imageText(new Blob(["x"]), "en")).toEqual({ alt: "A cat on a red sofa.", source: "vision" });
    const chatBody = JSON.parse(String((f.mock.calls.at(-1)![1] as RequestInit).body));
    expect(chatBody.messages[0].images).toHaveLength(1);
  });

  it("rewrites only that image, escaping Markdown", () => {
    const md = "a ![lumen-asset-1](lumen-asset-1.png) b ![x](other.png)";
    const out = withImageText(md, "lumen-asset-1.png", "lumen-asset-1", { alt: "Image with text: [Q3] plan", title: 'say "hi"\nnext', source: "ocr" });
    expect(out).toBe(`a ![Image with text:  Q3  plan](lumen-asset-1.png "say 'hi' · next") b ![x](other.png)`.replace("  Q3  ", " Q3 "));
    expect(escapeAlt("a]b")).toBe("a b");
    expect(escapeTitle('"q"')).toBe("'q'");
  });
});

describe("which images need alt text", () => {
  it("keeps real one-word alt text, picks empty and file-name alts", () => {
    expect(altIsPlaceholder("logo", "logo.png")).toBe(true); // the file's own name
    expect(altIsPlaceholder("logo", "assets/brand.png")).toBe(false);
    expect(altIsPlaceholder("cat", "assets/photo.png")).toBe(false);
    expect(altIsPlaceholder("", "assets/a.png")).toBe(true);
    expect(altIsPlaceholder("image", "assets/lq1-abc.png")).toBe(true); // clipboard paste
    expect(altIsPlaceholder("IMG_1234", "assets/x.jpg")).toBe(true);
    expect(altIsPlaceholder("Screenshot 2026-10-18 at 10.00.00", "assets/x.png")).toBe(true);
    expect(altIsPlaceholder("photo of the team", "assets/x.png")).toBe(false);
    expect(altIsPlaceholder("diagram.png", "assets/x.png")).toBe(true);
  });

  it("imagesNeedingAlt skips remote/data images and real descriptions", () => {
    const md = "![logo](logo.png) ![cat](photo.png) ![](a.png) ![x](https://e.com/x.png) ![image](data:image/png;base64,AA)";
    expect(imagesNeedingAlt(md)).toEqual([
      { alt: "logo", url: "logo.png" },
      { alt: "", url: "a.png" },
    ]);
  });
});
