/**
 * W3.9 — the desktop shell, WebView side: which window this is, per-window
 * state, tab state that travels between windows, the drop-outside test, and
 * open requests (a file of another vault switches vaults first). The Rust
 * decisions are tested in src-tauri/desktop (`cargo test --offline`).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { droppedOutside, handleOpenRequest, parseTabState, seedFromMain, storeKeyFor, windowLabel, windowStorage, type OpenDeps, type OpenRequest } from "../desktop/shell";

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe("windows", () => {
  it("the label comes from the URL Rust opened; anything else is main", () => {
    expect(windowLabel("?window=w-3")).toBe("w-3");
    expect(windowLabel("?window=capture")).toBe("capture");
    expect(windowLabel("")).toBe("main");
    expect(windowLabel("?window=../x")).toBe("main");
    expect(windowLabel("?window=w-")).toBe("main");
  });

  it("each window keeps its own note and tabs; a new one starts with main's settings only", () => {
    const base = mem();
    base.setItem("lumen-md", JSON.stringify({ state: { theme: "dark", locale: "he", doc: { name: "a.md", content: "secret" }, openTabs: [{ id: "a.md" }] }, version: 0 }));
    const w2 = windowStorage("w-2", base);
    const seeded = JSON.parse(w2.getItem("lumen-md")!);
    expect(seeded.state).toEqual({ theme: "dark", locale: "he" });
    w2.setItem("lumen-md", JSON.stringify({ state: { theme: "light", doc: { name: "b.md" } }, version: 0 }));
    expect(base.getItem(storeKeyFor("w-2"))).toContain("b.md");
    expect(JSON.parse(base.getItem("lumen-md")!).state.doc.name).toBe("a.md");
    expect(JSON.parse(w2.getItem("lumen-md")!).state.doc.name).toBe("b.md");
    expect(windowStorage("main", base)).toBe(base);
    expect(seedFromMain(null)).toBe(null);
    expect(seedFromMain("{bad")).toBe(null);
  });
});

describe("a tab's editing state between windows", () => {
  const good = { id: "notes/a.md", name: "a.md", workspaceName: "notes/a.md", content: "שלום עולם", dirty: true, mode: "source", selection: { anchor: 3, head: 99 }, scrollTop: 240 };

  it("keeps unsaved text, cursor (clamped to the text), scroll and view mode", () => {
    const s = parseTabState(JSON.stringify(good))!;
    expect(s).toEqual({ ...good, selection: { anchor: 3, head: 9 } });
  });

  it("refuses anything that isn't a tab state, and drops bad optional fields", () => {
    expect(parseTabState("nope")).toBe(null);
    expect(parseTabState(JSON.stringify({ ...good, content: 5 }))).toBe(null);
    expect(parseTabState(JSON.stringify({ ...good, dirty: "yes" }))).toBe(null);
    expect(parseTabState(JSON.stringify({ ...good, workspaceName: 3 }))).toBe(null);
    const s = parseTabState(JSON.stringify({ ...good, mode: "evil", scrollTop: -1, selection: { anchor: 1.5, head: 2 } }))!;
    expect(s.mode).toBe(undefined);
    expect(s.scrollTop).toBe(undefined);
    expect(s.selection).toBe(undefined);
  });

  it("a drop outside the window", () => {
    const size = { w: 1200, h: 800 };
    expect(droppedOutside({ clientX: 600, clientY: 400 }, size)).toBe(false);
    expect(droppedOutside({ clientX: 1300, clientY: 400 }, size)).toBe(true);
    expect(droppedOutside({ clientX: -5, clientY: 400 }, size)).toBe(true);
    expect(droppedOutside({ clientX: 0, clientY: 0 }, size)).toBe(true);
  });
});

describe("open requests", () => {
  function deps(active: string) {
    const calls: string[] = [];
    const d: OpenDeps = {
      activeRoot: () => active,
      switchVault: async (r) => void calls.push(`switch ${r}`),
      openVaultFile: async (rel, line) => void calls.push(`open ${rel}${line ? `:${line}` : ""}`),
      openStandalone: async (t, n) => void calls.push(`file ${t} ${n}`),
      newNote: async (t) => void calls.push(`new ${t ?? ""}`),
      capture: async (t) => void calls.push(`capture ${t}`),
      notifyUnknownVault: (n) => void calls.push(`unknown ${n}`),
    };
    return { d, calls };
  }
  const run = async (req: OpenRequest, active = "/v/Notes") => {
    const { d, calls } = deps(active);
    await handleOpenRequest(req, d);
    return calls;
  };

  it("a file of the active vault opens; of another known vault, switches first", async () => {
    expect(await run({ kind: "vault", root: "/v/Notes", rel: "a.md", line: null })).toEqual(["open a.md"]);
    expect(await run({ kind: "vault", root: "/v/Research", rel: "b.md", line: 4 })).toEqual(["switch /v/Research", "open b.md:4"]);
    // App storage (no folder vault): no switch.
    expect(await run({ kind: "vault", root: "", rel: "c.md", line: null })).toEqual(["open c.md"]);
  });

  it("standalone files, new notes, capture, unknown vaults", async () => {
    expect(await run({ kind: "file", token: "f1", name: "x.md" })).toEqual(["file f1 x.md"]);
    expect(await run({ kind: "new", title: "רעיון", text: null, folder: null })).toEqual(["new רעיון"]);
    expect(await run({ kind: "capture", text: "לקנות חלב" })).toEqual(["capture לקנות חלב"]);
    expect(await run({ kind: "unknown-vault", name: "מחקר" })).toEqual(["unknown מחקר"]);
  });
});

describe("config", () => {
  const root = process.cwd();
  it("tauri.conf.json registers .md, .base, .excalidraw and lumen://; every window has the capabilities", () => {
    const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
    const exts = conf.bundle.fileAssociations.flatMap((a: { ext: string[] }) => a.ext);
    for (const e of ["md", "base", "excalidraw"]) expect(exts).toContain(e);
    expect(conf.plugins["deep-link"].desktop.schemes).toEqual(["lumen"]);
    const cap = JSON.parse(readFileSync(join(root, "src-tauri/capabilities/default.json"), "utf8"));
    // The presenter window (#406, slides) shares the main window's capabilities.
    expect(cap.windows).toEqual(["main", "presenter", "w-*", "capture"]);
    // Still no fs: permission for the WebView.
    expect(cap.permissions.some((p: string) => p.startsWith("fs:"))).toBe(false);
  });

  it("the file types match the Rust list", () => {
    const rs = readFileSync(join(root, "src-tauri/desktop/src/fileopen.rs"), "utf8");
    const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
    const exts = conf.bundle.fileAssociations.flatMap((a: { ext: string[] }) => a.ext).sort();
    const list = /EXTENSIONS: &\[&str\] = &\[([^\]]+)\]/.exec(rs)![1].match(/"([^"]+)"/g)!.map((x) => x.slice(1, -1)).sort();
    expect(list).toEqual(exts);
  });

  it("the docs page documents every link and the manual checks on three systems, in English and Hebrew", () => {
    for (const f of ["docs/src/content/docs/getting-started/desktop-app.md", "docs/src/content/docs/he/getting-started/desktop-app.md"]) {
      const md = readFileSync(join(root, f), "utf8");
      for (const l of ["lumen://open?path=", "lumen://new", "lumen://capture?text="]) expect(md, `${f}: ${l}`).toContain(l);
      for (const os of ["macOS", "Windows", "Linux"]) expect(md, `${f}: ${os}`).toContain(os);
    }
    expect(readFileSync(join(root, "docs/astro.config.mjs"), "utf8")).toContain('slug: "getting-started/desktop-app"');
  });
});
