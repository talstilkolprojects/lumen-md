/** Plan W7.9: the HTML export names a Yiddish or Ladino note's language in <html lang>. */
import { describe, expect, it } from "vitest";
import { renderHtmlDocument } from "../storage/exportHtml";

describe("export: the note's language tag (W7.9)", () => {
  it("names Yiddish and Ladino in <html lang>, and keeps Hebrew and English as before", async () => {
    expect(await renderHtmlDocument("# ייִדיש\n\nמיר וווינען אין דער שטאָט און לייענען ביכער אויף ייִדיש.", { title: "Y" })).toMatch(/<html lang="yi" dir="rtl"/);
    expect(await renderHtmlDocument("---\nlang: lad\n---\nKe haber? Aki Yerushalayim.", { title: "L" })).toMatch(/<html lang="lad-Latn" dir="ltr"/);
    expect(await renderHtmlDocument("שלום, זו פסקה בעברית.", { title: "H" })).toMatch(/<html lang="he" dir="rtl"/);
    expect(await renderHtmlDocument("Plain English.", { title: "E" })).toMatch(/<html lang="en" dir="ltr"/);
  });
});
