/** T45 — Hebrew welcome, Hebrew templates, OS-aware shortcuts. */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { welcomeDoc } from "../welcomeDoc";
import { WELCOME_DOC } from "../welcome";
import { WELCOME_DOC_HE } from "../welcome.he";
import { localizeTemplate, type MarketplaceTemplate } from "../storage/templateMarketplace";
import { __setMacPlatform } from "../lib/platformKeys";
import { hebrewRatio } from "../text/hebrew";

afterEach(() => __setMacPlatform(null));

const fences = (s: string) => s.match(/^```[\s\S]*?^```/gm) ?? [];

describe("welcome document", () => {
  it("is Hebrew for a Hebrew UI and English otherwise", () => {
    __setMacPlatform(true);
    expect(welcomeDoc("he")).toBe(WELCOME_DOC_HE);
    expect(welcomeDoc("en")).toBe(WELCOME_DOC);
    expect(hebrewRatio(WELCOME_DOC_HE.replace(/^```[\s\S]*?^```/gm, ""))).toBeGreaterThan(0.5);
  });

  it("the Hebrew version keeps every code / data block of the English one", () => {
    expect(fences(WELCOME_DOC_HE)).toEqual(fences(WELCOME_DOC));
  });

  it("shows Ctrl shortcuts outside macOS", () => {
    __setMacPlatform(false);
    const doc = welcomeDoc("en");
    expect(doc).not.toMatch(/⌘/);
    expect(doc).toContain("Ctrl+K");
  });
});

describe("templates", () => {
  const registry = JSON.parse(readFileSync(join(__dirname, "../../public/templates/registry.json"), "utf8")) as { templates: MarketplaceTemplate[] };

  it("every template has a Hebrew body, name and description", () => {
    const local = registry.templates.filter((t) => !/^https?:/.test(t.url));
    expect(local.length).toBeGreaterThanOrEqual(10);
    for (const t of local) {
      expect(t.url_he, t.id).toBeTruthy();
      expect(existsSync(join(__dirname, "../../public", t.url_he!)), t.url_he).toBe(true);
      expect(hebrewRatio(t.name_he ?? "")).toBeGreaterThan(0.3);
    }
  });

  it("localizeTemplate picks the Hebrew fields only for Hebrew", () => {
    const tpl = registry.templates.find((t) => t.url_he)!;
    expect(localizeTemplate(tpl, "he").url).toBe(tpl.url_he);
    expect(localizeTemplate(tpl, "he").name).toBe(tpl.name_he);
    expect(localizeTemplate(tpl, "de")).toBe(tpl);
  });
});
