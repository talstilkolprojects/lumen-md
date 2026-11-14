/**
 * Plan 11.2 (b) — the plugin API surface against the real app services
 * (store, commands, panel, renderers, settings, storage), with the two
 * example plugins (public/plugins/examples) running in the real QuickJS
 * sandbox. Grants are checked per capability: without one, the call fails
 * and nothing changes in the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { useAppStore } from "../store/useStore";
import { getPluginCommands } from "../plugins/pluginSystem";
import { pluginForLang } from "../plugins/runtime/rendererRegistry";
import { parseManifest } from "../plugins/runtime/manifest";
import { grantsFrom } from "../plugins/runtime/capabilities";
import { appServices, clearPluginData, getPanel, pluginVaultPath, renderBlock, runningPlugins, sendUiEvent, startPlugin, stopPlugin } from "../plugins/runtime/manager";
import { fakePluginWorker } from "./helpers/pluginWorker";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../plugins/runtime/PluginPanel", () => ({ ensurePanelHost: vi.fn() }));

const root = resolve(__dirname, "../..");
const example = (name: string) => {
  const dir = join(root, "public/plugins/examples", name);
  const manifest = parseManifest(readFileSync(join(dir, "lumen-plugin.json"), "utf8"));
  return { manifest, code: readFileSync(join(dir, manifest.main), "utf8") };
};

const start = (name: string, grants?: string[]) => {
  const { manifest, code } = example(name);
  return startPlugin({ manifest, code, grants: grantsFrom(grants ?? manifest.capabilities.map((c) => c.id)), createWorker: fakePluginWorker });
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ doc: { ...useAppStore.getState().doc, name: "יומן.md", content: "שלום עולם, שלום לכולם. Hello world hello.\n\n```js\nignored code words\n```" } });
});
afterEach(async () => {
  for (const p of runningPlugins()) await stopPlugin(p.id);
});

describe("example: Word stats (commands, panel, settings, document:read)", () => {
  it("registers its command in the palette; running it opens a panel with the numbers", async () => {
    await start("word-stats");
    await vi.waitFor(() => expect(getPluginCommands().map((c) => c.id)).toContain("plugin:lumen.example.word-stats:show"));
    const cmd = getPluginCommands().find((c) => c.id === "plugin:lumen.example.word-stats:show")!;
    expect(cmd.label).toBe("Word stats · Word stats");
    cmd.action();
    await vi.waitFor(() => expect(getPanel()?.tree).toBeTruthy());
    const json = JSON.stringify(getPanel());
    expect(getPanel()).toMatchObject({ pluginId: "lumen.example.word-stats", title: "Word stats" });
    expect(json).toContain("יומן.md");
    expect(json).toContain("Words: 7"); // code fences are not counted
    expect(json).toContain("שלום — 2");
    expect(json).toContain("hello — 2");
  });
  it("a panel event changes its setting and re-renders with it", async () => {
    await start("word-stats");
    await vi.waitFor(() => expect(getPluginCommands().length).toBeGreaterThan(0));
    getPluginCommands().find((c) => c.id.endsWith(":show"))!.action();
    await vi.waitFor(() => expect(getPanel()?.tree).toBeTruthy());
    sendUiEvent("lumen.example.word-stats", { scope: "panel", id: "wpm", kind: "change", value: "300" });
    await vi.waitFor(() => expect(JSON.stringify(getPanel())).toContain("at 300 words/min"));
    expect(JSON.parse(localStorage.getItem("lumen.plugin.settings.lumen.example.word-stats")!)).toEqual({ wpm: 300 });
  });
  it("without the panel grant the command runs but nothing opens, and the plugin stops", async () => {
    const p = await start("word-stats", ["document:read", "commands", "settings"]);
    await vi.waitFor(() => expect(getPluginCommands().length).toBeGreaterThan(0));
    getPluginCommands().find((c) => c.id.endsWith(":show"))!.action();
    await vi.waitFor(() => expect(p.alive).toBe(false));
    expect(getPanel()).toBeNull();
    expect(getPluginCommands().filter((c) => c.id.startsWith("plugin:lumen.example.word-stats"))).toEqual([]);
  });
  it("without commands it cannot even start (its top level registers one)", async () => {
    await expect(start("word-stats", ["document:read", "panel", "settings"])).rejects.toThrow(/commands/);
    expect(getPluginCommands().filter((c) => c.id.startsWith("plugin:"))).toEqual([]);
  });
});

describe("example: Callout cards (renderer, storage)", () => {
  it("renders ```callout blocks as a UI tree with a checklist and note links", async () => {
    await start("callout");
    await vi.waitFor(() => expect(pluginForLang("callout")).toBe("lumen.example.callout"));
    const tree = await renderBlock("callout", "לקנות\n- [ ] חלב\n- [x] לחם\nראו [[רשימות|רשימה]]");
    const json = JSON.stringify(tree);
    expect(tree).toMatchObject({ type: "box" });
    expect((tree as { children: unknown[] }).children[0]).toEqual({ type: "heading", level: 3, text: "לקנות" });
    expect(json).toContain('"type":"checkbox"');
    expect(json).toContain('"checked":true,"label":"לחם"');
    expect(json).toContain('{"type":"noteLink","target":"רשימות","label":"רשימה"}');
  });
  it("keeps ticks in its own storage and shows them on the next render", async () => {
    await start("callout");
    await vi.waitFor(() => expect(pluginForLang("callout")).toBeTruthy());
    const src = "Todo\n- [ ] one";
    const first = JSON.stringify(await renderBlock("callout", src));
    const id = /"id":"([^"]+)"/.exec(first)![1];
    sendUiEvent("lumen.example.callout", { scope: "block", id, kind: "change", value: true });
    await vi.waitFor(async () => expect(JSON.stringify(await renderBlock("callout", src))).toContain('"checked":true'));
    await clearPluginData("lumen.example.callout");
    expect(JSON.stringify(await renderBlock("callout", src))).not.toContain('"checked":true');
  });
  it("stopping the plugin releases its language", async () => {
    await start("callout");
    await vi.waitFor(() => expect(pluginForLang("callout")).toBeTruthy());
    await stopPlugin("lumen.example.callout");
    expect(pluginForLang("callout")).toBeUndefined();
    await expect(renderBlock("callout", "x")).rejects.toThrow(/no running plugin/);
  });
  it("without the renderer grant it does not start and registers nothing", async () => {
    await expect(start("callout", ["storage"])).rejects.toThrow(/renderer/);
    expect(pluginForLang("callout")).toBeUndefined();
  });
});

describe("app services validate what plugins send", () => {
  const s = appServices();
  const fake = { id: "x.y.z", manifest: { name: "X" } } as never;
  it("refuses Lumen's own languages and malformed ones", () => {
    expect(() => s["renderer.register"]!(fake, "mermaid")).toThrow();
    expect(() => s["renderer.register"]!(fake, "Bad Lang")).toThrow();
  });
  it("keeps vault paths inside the vault and away from app data", () => {
    expect(pluginVaultPath("Notes/a.md")).toBe("Notes/a.md");
    for (const bad of ["../x.md", "/etc/passwd", "a/../../b.md", ".trash/x.md", "a/.lumen/x", "./a.md"]) expect(() => pluginVaultPath(bad)).toThrow(/inside the vault/);
  });
  it("caps settings size", () => {
    expect(() => s["settings.set"]!(fake, { big: "x".repeat(70 * 1024) })).toThrow(/larger/);
  });
});
