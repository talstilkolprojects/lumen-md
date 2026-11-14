// @vitest-environment node
/**
 * Plan W2.6, step 3 — listening to a PDF: its pages as one text for
 * read-aloud, cleaned the way a voice needs, and which page each sentence
 * came from, so the reader follows the voice.
 */
import { describe, expect, it } from "vitest";
import { listeningText, pageAt, pageForListening } from "../pdf/pdfListen";
import { speakableSentences } from "../ai/tts";

describe("W2.6 a PDF's text, ready to be read aloud", () => {
  it("joins the lines of a paragraph, mends a word hyphenated across lines, and keeps paragraphs apart", () => {
    expect(pageForListening("The quick brown fox jumps over the infor-\nmation highway\nand runs.\n\nNext paragraph.")).toBe("The quick brown fox jumps over the information highway and runs.\n\nNext paragraph.");
    // Hebrew maqaf and a real hyphen before a capital are kept.
    expect(pageForListening("בית־ספר\ngood-\nBye")).toBe("בית־ספר good- Bye");
  });

  it("puts Hebrew stored in visual order back in reading order", () => {
    const logical = "שלום לכם, זה מסמך בעברית שנשמר בסדר הפוך כמו בהרבה קבצי PDF ישנים.";
    const visual = Array.from(logical).reverse().join("");
    const out = pageForListening(visual);
    expect(out).toContain("שלום");
    expect(out).toContain("בעברית");
  });

  it("reads a line that looks like Markdown as its words", () => {
    const lt = listeningText([{ page: 1, text: "# 1 Introduction\n\n> quoted line\n\n* starred" }]);
    expect(speakableSentences(lt.text).map((x) => x.text)).toEqual(["1 Introduction", "quoted line", "starred"]);
  });

  it("knows the page of every sentence, and leaves out pages with no text", () => {
    const lt = listeningText([
      { page: 1, text: "First page, first sentence. Second sentence." },
      { page: 2, text: "   " },
      { page: 3, text: "Third page here." },
    ]);
    expect(lt.pages.map((p) => p.page)).toEqual([1, 3]);
    const pages = speakableSentences(lt.text).map((s) => pageAt(lt, s.from));
    expect(pages).toEqual([1, 1, 3]);
    expect(pageAt(lt, 0)).toBe(1);
    expect(pageAt(listeningText([]), 0)).toBeNull();
    expect(listeningText([]).text).toBe("");
  });
});
