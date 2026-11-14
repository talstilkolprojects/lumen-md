/** The boot shell paints in the saved theme: public/theme-boot.js runs before it (C1). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const script = readFileSync(join(root, "public/theme-boot.js"), "utf8");
const boot = () => new Function(script)();
const saved = (theme: string) => localStorage.setItem("lumen-md", JSON.stringify({ state: { theme }, version: 0 }));
function osDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: dark && q.includes("dark"), media: q, addEventListener() {}, removeEventListener() {} }));
}

describe("theme boot script", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "dark"; // index.html's fallback
    osDark(true);
  });

  it("is loaded in <head>, before the boot shell", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    const at = html.indexOf('<script src="/theme-boot.js"></script>');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf("</head>"));
  });

  it("applies a saved light theme", () => {
    saved("light");
    boot();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the OS for the system theme", () => {
    saved("system");
    osDark(false);
    boot();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    osDark(true);
    boot();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("stays dark with nothing saved or corrupt storage", () => {
    boot();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    localStorage.setItem("lumen-md", "{oops");
    boot();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
