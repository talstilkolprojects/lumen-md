import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W7.9 — the RTL matrix (9.5) for Yiddish and Ladino: a Yiddish note
 * reads right to left and is tagged `yi`; Ladino in Latin letters reads left
 * to right and in Hebrew letters right to left, each with its own tag; a
 * Latin quote inside the Yiddish note keeps its own direction. Checked on
 * the browser's computed direction, in the preview and the HTML export's
 * `lang`, with the interface in English and Hebrew.
 */

const YIDDISH = "# ייִדיש\n\nמיר וווינען אין דער שטאָט און לייענען ביכער אויף ייִדיש.\n\nA line in English inside a Yiddish note.\n\n- אַ ליד\n- אַ מעשׂה\n";
const LADINO_LATN = "---\nlang: lad\n---\n# Djudeo-espanyol\n\nKe haber? Aki Yerushalayim es una revista en ladino.\n";
const LADINO_HEBR = "---\nlang: lad\n---\n# ג׳ודיאו-איספאנייול\n\nקי חאבֿיר? אקי ירושלים איס אונה ריב׳יסטה.\n";

async function open(page: Page, content: string, locale: "en" | "he") {
  await page.addInitScript(
    ({ content, locale }) => {
      localStorage.clear();
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale, mode: "preview", doc: { name: "Lang.md", content, dirty: false, workspaceName: null } }, version: 0 }));
    },
    { content, locale },
  );
  await page.goto("/");
}

const dirOf = (page: Page, selector: string) => page.locator(".prose-lumen").first().locator(selector).first().evaluate((el) => getComputedStyle(el).direction);

for (const locale of ["en", "he"] as const) {
  test.describe(`Yiddish and Ladino, interface ${locale} (W7.9)`, () => {
    test("a Yiddish note: right to left, tagged yi, an English line left to right", async ({ page }) => {
      await open(page, YIDDISH, locale);
      const preview = page.locator(".prose-lumen").first();
      await expect(preview.locator("h1")).toContainText("ייִדיש", { timeout: 15_000 });
      await expect(preview).toHaveAttribute("lang", "yi");
      expect(await dirOf(page, "h1")).toBe("rtl");
      expect(await dirOf(page, "p:has-text('מיר וווינען')")).toBe("rtl");
      expect(await dirOf(page, "p:has-text('A line in English')")).toBe("ltr");
      expect(await dirOf(page, "ul")).toBe("rtl");
    });

    test("Ladino in Latin letters: left to right, lad-Latn", async ({ page }) => {
      await open(page, LADINO_LATN, locale);
      const preview = page.locator(".prose-lumen").first();
      await expect(preview.locator("h1")).toContainText("Djudeo", { timeout: 15_000 });
      await expect(preview).toHaveAttribute("lang", "lad-Latn");
      expect(await dirOf(page, "p")).toBe("ltr");
    });

    test("Ladino in Hebrew letters: right to left, lad-Hebr", async ({ page }) => {
      await open(page, LADINO_HEBR, locale);
      const preview = page.locator(".prose-lumen").first();
      await expect(preview.locator("h1")).toContainText("איספאנייול", { timeout: 15_000 });
      await expect(preview).toHaveAttribute("lang", "lad-Hebr");
      expect(await dirOf(page, "p")).toBe("rtl");
    });
  });
}
