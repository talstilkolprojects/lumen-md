/** Plan W2.21: the boot shell shows the last note before the bundle loads (public/note-boot.js). */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const script = readFileSync(join(root, "public/note-boot.js"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const boot = () => new Function(script)();
const SHELL = '<div class="boot-shell"><div class="boot-bar"></div><div class="boot-page"><div class="boot-line"></div></div></div>';
const saved = (state: unknown) => localStorage.setItem("lumen-md", JSON.stringify({ state, version: 0 }));
const page = () => document.querySelector(".boot-page")!;

describe("note boot script", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = SHELL;
    document.documentElement.removeAttribute("data-boot-note");
  });

  it("runs after the boot shell and before the app module", () => {
    const at = html.indexOf('<script src="/note-boot.js"></script>');
    expect(at).toBeGreaterThan(html.indexOf('class="boot-shell"'));
    expect(at).toBeLessThan(html.indexOf('<script type="module"'));
  });

  it("shows the persisted note as text, never as HTML", () => {
    saved({ doc: { content: "# שלום\n\n<img src=x onerror=alert(1)> text" } });
    boot();
    const note = page().querySelector("pre.boot-note")!;
    expect(note.textContent).toContain("# שלום");
    expect(page().querySelector("img")).toBeNull();
    expect(page().querySelector(".boot-line")).toBeNull();
    expect(note.getAttribute("dir")).toBe("auto");
    expect(document.documentElement.hasAttribute("data-boot-note")).toBe(true);
  });

  it("shows only the beginning of a long note", () => {
    saved({ doc: { content: "x".repeat(10_000) }, rtl: true });
    boot();
    expect(page().textContent!.length).toBe(4000);
    expect(page().querySelector("pre")!.getAttribute("dir")).toBe("rtl");
  });

  it("keeps the skeleton with nothing saved, an empty note or corrupt storage", () => {
    boot();
    expect(page().querySelector(".boot-line")).not.toBeNull();
    saved({ doc: { content: "   " } });
    boot();
    expect(page().querySelector(".boot-line")).not.toBeNull();
    localStorage.setItem("lumen-md", "{oops");
    boot();
    expect(page().querySelector(".boot-line")).not.toBeNull();
  });
});
