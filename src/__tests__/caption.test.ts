/** Plan 6.6 — browser captions: cleaning, the validator, consent, fallback, translation, and the order in imageText. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { translateLocally, captionLocal, ocrImage } = vi.hoisted(() => ({
  translateLocally: vi.fn(async (_t: string, _p: unknown, _c: unknown, _o?: unknown) => ({ layer: null, reasons: {} }) as { layer: string | null; text?: string; reasons?: unknown }),
  captionLocal: vi.fn(async (_m: string, _f: string, _b: Blob, _o: unknown) => "a red bicycle leaning on a wall"),
  ocrImage: vi.fn(async () => ({ text: "", confidence: 0 })),
}));
vi.mock("../ai/mt", () => ({ translateLocally }));
vi.mock("../ai/transformersEngine", () => ({ captionLocal }));
vi.mock("../ai/ocr", () => ({ ocrImage, meaningfulText: () => false }));

import { CAPTION_MODELS, captionInBrowser, captionInLanguage, cleanCaption, validCaption } from "../ai/caption";
import { imageText } from "../ai/vision";

function memory(): Pick<Storage, "getItem" | "setItem"> & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
const consent = (answer: boolean) => ({ confirm: vi.fn(async () => answer), t: (k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k) });
const [FLORENCE, SMOL] = CAPTION_MODELS;

describe("cleanCaption / validCaption", () => {
  it("strips special tokens and echoes; capitalises; rejects non-answers", () => {
    expect(cleanCaption("</s><s>a cat on a sofa</s><pad>")).toBe("A cat on a sofa");
    expect(cleanCaption("Assistant: \"A dog running.\"")).toBe("A dog running.");
    expect(cleanCaption("unanswerable")).toBe("");
    expect(cleanCaption("x".repeat(10) + " " + "y".repeat(300)).length).toBeLessThanOrEqual(201);
  });

  it("not empty, not one word, not the file name, not the prompt read back", () => {
    expect(validCaption("A cat on a sofa", "photo.jpg")).toBe(true);
    expect(validCaption("", "photo.jpg")).toBe(false);
    expect(validCaption("Cat", "photo.jpg")).toBe(false);
    expect(validCaption("IMG_1234.jpg", "IMG_1234.jpg")).toBe(false);
    expect(validCaption("Screenshot 2026-10-18 at 10.00.00", "s.png")).toBe(false);
    expect(validCaption("holiday photo", "attachments/holiday photo.png")).toBe(false);
    expect(validCaption("Describe this image in one short sentence.", "a.png")).toBe(false);
  });
});

describe("captionInBrowser", () => {
  const img = new Blob(["png"]);

  it("in the background (no consent) a model the user never agreed to is not downloaded", async () => {
    const run = vi.fn(async () => "a cat");
    expect(await captionInBrowser(img, { caption: run, storage: memory() })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("asks once with size, licence and attribution; afterwards no dialog", async () => {
    const storage = memory();
    const c = consent(true);
    const run = vi.fn(async () => "a red bicycle leaning on a wall");
    expect(await captionInBrowser(img, { caption: run, storage, consent: c })).toEqual({ text: "A red bicycle leaning on a wall", model: FLORENCE.id });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    const msg = (c.confirm.mock.calls[0] as unknown as [{ message: string }])[0].message;
    expect(msg).toContain(FLORENCE.id);
    expect(msg).toContain("MIT");
    expect(msg).toContain("caption.attribution.florence");
    expect(msg).toContain("224 MB");
    expect(await captionInBrowser(img, { caption: run, storage })).not.toBeNull(); // background now works, no consent needed
  });

  it("a declined download stops: no dialog for the fallback, no model run", async () => {
    const c = consent(false);
    const run = vi.fn(async () => "x y");
    expect(await captionInBrowser(img, { caption: run, storage: memory(), consent: c })).toBeNull();
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("Florence-2 fails to load or gives the file name: SmolVLM is the fallback", async () => {
    const storage = memory();
    const run = vi.fn(async (m: string) => {
      if (m === FLORENCE.id) throw new Error("out of memory");
      return "a dog on a beach";
    });
    expect(await captionInBrowser(img, { caption: run, storage, consent: consent(true) })).toEqual({ text: "A dog on a beach", model: SMOL.id });
    const placeholder = vi.fn(async (m: string) => (m === FLORENCE.id ? "IMG_0042" : "a dog on a beach"));
    expect((await captionInBrowser(img, { caption: placeholder, storage, name: "IMG_0042.jpg" }))?.model).toBe(SMOL.id);
  });

  it("an abort is not swallowed", async () => {
    const storage = memory();
    storage.setItem(`lumen.caption.ready.${FLORENCE.id}`, "1");
    const run = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(captionInBrowser(img, { caption: run, storage })).rejects.toThrow(/aborted/);
  });
});

describe("captionInLanguage", () => {
  beforeEach(() => translateLocally.mockClear());

  it("English stays; another language goes through local translation (en → target)", async () => {
    expect(await captionInLanguage("A cat", "en")).toEqual({ text: "A cat", lang: "en" });
    translateLocally.mockResolvedValueOnce({ layer: "m2m100", text: "חתול על ספה" });
    expect(await captionInLanguage("A cat on a sofa", "he")).toEqual({ text: "חתול על ספה", lang: "he" });
    expect(translateLocally.mock.calls[0][1]).toEqual({ source: "en", target: "he" });
  });

  it("no local layer: the English caption, marked en; in the background downloads are declined", async () => {
    expect(await captionInLanguage("A cat on a sofa", "fr")).toEqual({ text: "A cat on a sofa", lang: "en" });
    const quiet = translateLocally.mock.calls[0][2] as { confirm: () => Promise<boolean> };
    expect(await quiet.confirm()).toBe(false);
  });
});

describe("imageText order: OCR → Ollama → browser → none", () => {
  beforeEach(() => {
    localStorage.clear();
    captionLocal.mockClear();
    translateLocally.mockClear();
    // No Ollama on this machine.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection refused");
    }));
  });

  it("no Ollama, no consent yet: nothing is invented and nothing is downloaded", async () => {
    expect(await imageText(new Blob(["x"]), "en", { name: "IMG_1.png" })).toEqual({ alt: "", source: "none" });
    expect(captionLocal).not.toHaveBeenCalled();
  });

  it("with consent: the browser caption, translated into the note's language when a layer can", async () => {
    translateLocally.mockResolvedValueOnce({ layer: "chrome", text: "אופניים אדומים נשענים על קיר" });
    const res = await imageText(new Blob(["x"]), "he", { name: "IMG_1.png", consent: consent(true) });
    expect(res).toEqual({ alt: "אופניים אדומים נשענים על קיר", source: "browser", lang: "he", model: FLORENCE.id });
  });

  it("an Ollama vision model answers first", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).endsWith("/api/tags")
        ? new Response(JSON.stringify({ models: [{ name: "qwen2.5vl:3b" }] }))
        : new Response(JSON.stringify({ message: { content: "A bowl of fruit on a table." } })),
    ));
    expect(await imageText(new Blob(["x"]), "en", { name: "a.png", consent: consent(true) })).toEqual({ alt: "A bowl of fruit on a table.", source: "vision" });
    expect(captionLocal).not.toHaveBeenCalled();
  });
});
