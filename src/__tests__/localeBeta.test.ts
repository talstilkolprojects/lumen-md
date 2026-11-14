/** Plan W4.18: the six machine-translated languages are marked beta, and a better translation can be suggested with no server. */
import { describe, it, expect } from "vitest";
import { SUPPORTED_LOCALES } from "../i18n";
import { LOCALE_REVIEW, betaLocales, isBetaLocale } from "../i18n/review";
import { findStrings, suggestionBody, suggestionLink, suggestionTitle } from "../i18n/suggest";
import { MAX_ISSUE_URL } from "../feedback/feedback";

describe("locale review status", () => {
  it("every UI language has a status; the six without a native speaker are beta", () => {
    expect(Object.keys(LOCALE_REVIEW).sort()).toEqual(SUPPORTED_LOCALES.map((l) => l.code).sort());
    expect(betaLocales().sort()).toEqual(["ar", "de", "fr", "ja", "ru", "zh-CN"]);
    expect(isBetaLocale("he")).toBe(false);
    expect(isBetaLocale("en")).toBe(false);
    expect(isBetaLocale("ru")).toBe(true);
  });
});

const EN = { "toolbar.save": "Save", "toolbar.saveAs": "Save as…", "tree.title": "Files", "x.long": "Save the note to a file on disk" };
const RU = { "toolbar.save": "Спасти", "toolbar.saveAs": "Сохранить как…", "tree.title": "Файлы", "x.long": "Сохранить заметку в файл" };

describe("finding the string the person saw", () => {
  it("by the translation: exact first, then the shortest that contains it", () => {
    expect(findStrings("спасти", RU, EN).map((m) => m.key)).toEqual(["toolbar.save"]);
    expect(findStrings("Сохранить", RU, EN).map((m) => m.key)).toEqual(["toolbar.saveAs", "x.long"]);
  });
  it("by the English too, and a missing translation shows the English", () => {
    expect(findStrings("files", RU, EN)[0]).toEqual({ key: "tree.title", current: "Файлы", english: "Files" });
    expect(findStrings("Files", {}, EN)[0].current).toBe("Files");
    expect(findStrings("x", RU, EN)).toEqual([]);
  });
});

describe("the GitHub issue link", () => {
  const s = { key: "toolbar.save", current: "Спасти", english: "Save", locale: "ru", suggestion: "Сохранить", note: "«Спасти» means rescue", version: "1.2.3" };
  it("goes to the project's new-issue form with the title, labels and body filled in", () => {
    const { url, withBody } = suggestionLink(s);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://github.com/talstilkol/lumen-md/issues/new");
    expect(u.searchParams.get("title")).toBe(suggestionTitle(s));
    expect(u.searchParams.get("title")).toBe("[i18n:ru] toolbar.save");
    expect(u.searchParams.get("labels")).toBe("i18n,locale:ru");
    expect(withBody).toBe(true);
    const body = u.searchParams.get("body")!;
    expect(body).toBe(suggestionBody(s));
    for (const part of ["`toolbar.save`", "Save", "Спасти", "Сохранить", "means rescue", "src/i18n/locales/ru/"]) expect(body).toContain(part);
  });
  it("a body too long for a link: the title only, so the person pastes the copied text", () => {
    const long = suggestionLink({ ...s, suggestion: "ж".repeat(4000) });
    expect(long.withBody).toBe(false);
    expect(long.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(new URL(long.url).searchParams.get("body")).toBeNull();
  });
});
