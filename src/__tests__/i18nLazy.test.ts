/**
 * Tests for the lazy-locale infrastructure (β.4.4).
 *
 * The 6 locales added to `SUPPORTED_LOCALES` (ar/ru/fr/de/ja/zh-CN)
 * now ship with a core set of ~50 translated keys each. Full translations
 * require running the OpenAI translate script. `isLocaleAvailable()` reports
 * them as available since they have real keys. `loadLocale()` resolves
 * cleanly and `t()` returns the translated value.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SUPPORTED_LOCALES,
  isLocaleAvailable,
  loadLocale,
  applyLocale,
  t,
} from "../i18n";

describe("β.4 lazy locale infrastructure", () => {
  it("declares all 8 supported locales", () => {
    const codes = SUPPORTED_LOCALES.map((l) => l.code);
    expect(codes).toEqual(["en", "he", "ar", "ru", "fr", "de", "ja", "zh-CN"]);
  });

  it("isLocaleAvailable returns true for en + he (synchronous bundles)", () => {
    expect(isLocaleAvailable("en")).toBe(true);
    expect(isLocaleAvailable("he")).toBe(true);
  });

  it("isLocaleAvailable returns true for locales with real translated keys", async () => {
    // All 6 locales now have ~50 core keys translated.
    await loadLocale("ar");
    expect(isLocaleAvailable("ar")).toBe(true);
    await loadLocale("fr");
    expect(isLocaleAvailable("fr")).toBe(true);
    await loadLocale("ru");
    expect(isLocaleAvailable("ru")).toBe(true);
  });

  it("ar / zh-CN are tagged with the right `dir`", () => {
    const ar = SUPPORTED_LOCALES.find((l) => l.code === "ar");
    const zh = SUPPORTED_LOCALES.find((l) => l.code === "zh-CN");
    expect(ar?.dir).toBe("rtl");
    expect(zh?.dir).toBe("ltr");
  });

  it("loadLocale returns the lazy bundle with real translated keys", async () => {
    const bundle = await loadLocale("ar");
    expect(typeof bundle).toBe("object");
    // ar.json now has real translations.
    applyLocale("ar");
    expect(t("toolbar.tagline")).toBe("Markdown، مُنار");
    applyLocale("en");
  });

  it("applyLocale sets the document direction even for unavailable locales", () => {
    applyLocale("ar");
    expect(document.documentElement.dir).toBe("rtl");
    applyLocale("fr");
    expect(document.documentElement.dir).toBe("ltr");
    // Restore.
    applyLocale("en");
  });

  it("t() returns translated value for loaded locale", async () => {
    await loadLocale("fr");
    applyLocale("fr");
    // fr.json has 'toolbar.new' translated.
    expect(t("toolbar.new")).toBe("Nouveau");
    applyLocale("en");
  });
});

describe("A7 lever 4 — only English ships eagerly", () => {
  // Fresh module instance per test so earlier loadLocale() calls don't leak.
  async function freshI18n() {
    vi.resetModules();
    return import("../i18n");
  }

  it("Hebrew is not in memory until loaded, but is reported available", async () => {
    const i18n = await freshI18n();
    expect(i18n.isLocaleLoaded("en")).toBe(true);
    expect(i18n.isLocaleLoaded("he")).toBe(false);
    expect(i18n.isLocaleAvailable("he")).toBe(true);
    await i18n.loadLocale("he");
    expect(i18n.isLocaleLoaded("he")).toBe(true);
  });

  it("initLocale() preloads + applies the persisted locale before first render", async () => {
    const i18n = await freshI18n();
    localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he" }, version: 0 }));
    const locale = await i18n.initLocale();
    expect(locale).toBe("he");
    expect(i18n.getLocale()).toBe("he");
    expect(i18n.t("toolbar.new")).toBe("חדש");
    expect(document.documentElement.dir).toBe("rtl");
    i18n.applyLocale("en");
    localStorage.removeItem("lumen-md");
  });

  it("initLocale() falls back to English (LTR) when the locale chunk can't load", async () => {
    vi.doMock("../i18n/locales/he/common.json", () => {
      throw new Error("offline");
    });
    try {
      const i18n = await freshI18n();
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he" }, version: 0 }));
      expect(await i18n.initLocale()).toBe("en");
      expect(i18n.getLocale()).toBe("en");
      expect(document.documentElement.dir).not.toBe("rtl");
    } finally {
      vi.doUnmock("../i18n/locales/he/common.json");
      localStorage.removeItem("lumen-md");
    }
  });

  it("boot fallback updates the rehydrated store so App's mount effect can't re-apply RTL", async () => {
    vi.doMock("../i18n/locales/he/common.json", () => {
      throw new Error("offline");
    });
    try {
      vi.resetModules();
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he" }, version: 0 }));
      const { useAppStore, adoptBootLocale } = await import("../store/useStore");
      const i18n = await import("../i18n");
      expect(useAppStore.getState().locale).toBe("he"); // rehydrated from storage
      adoptBootLocale(await i18n.initLocale());
      expect(useAppStore.getState().locale).toBe("en");
      // What App's effect does on mount:
      i18n.applyLocale(useAppStore.getState().locale);
      expect(document.documentElement.dir).not.toBe("rtl");
    } finally {
      vi.doUnmock("../i18n/locales/he/common.json");
      localStorage.removeItem("lumen-md");
    }
  });

  it("switching to a locale whose chunk can't load keeps the UI English and LTR", async () => {
    vi.doMock("../i18n/locales/he/common.json", () => {
      throw new Error("offline");
    });
    try {
      vi.resetModules();
      const i18n = await import("../i18n");
      const { useAppStore } = await import("../store/useStore");
      useAppStore.getState().setLocale("he");
      await vi.waitFor(() => expect(i18n.getLocale()).toBe("en"));
      expect(useAppStore.getState().locale).toBe("en");
      expect(document.documentElement.dir).not.toBe("rtl");
    } finally {
      vi.doUnmock("../i18n/locales/he/common.json");
    }
  });

  it("initLocale() defaults to English on missing / corrupt / unknown storage", async () => {
    const i18n = await freshI18n();
    localStorage.removeItem("lumen-md");
    expect(await i18n.initLocale()).toBe("en");
    localStorage.setItem("lumen-md", "{not json");
    expect(await i18n.initLocale()).toBe("en");
    localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "xx" } }));
    expect(await i18n.initLocale()).toBe("en");
    expect(i18n.t("toolbar.new")).toBe("New");
    localStorage.removeItem("lumen-md");
  });
});
