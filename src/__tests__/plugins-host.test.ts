/**
 * Plan 11.2 — the plugin host (main-thread side): grants are enforced here
 * as well, UI trees are validated, the network broker goes through the
 * privacy ledger, never with credentials, never under local-only, and only
 * to the exact granted origin. The worker is replaced by an in-process
 * fake that runs the real worker protocol over the real sandbox.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPlugin, pluginFetch, MAX_RESPONSE_BYTES } from "../plugins/runtime/pluginHost";
import { grantsFrom } from "../plugins/runtime/capabilities";
import { parseManifest } from "../plugins/runtime/manifest";
import { fakePluginWorker } from "./helpers/pluginWorker";
import { __resetLedger, ledgerEntries } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

const manifest = parseManifest({
  schema: 1,
  id: "test.host",
  name: "T",
  version: "0.1.0",
  description: "d",
  author: "a",
  license: "MIT",
  main: "main.js",
  capabilities: [
    { id: "document:read", reason: "r" },
    { id: "panel", reason: "r" },
    { id: "commands", reason: "r" },
    { id: "network:https://api.example.com", reason: "r" },
  ],
});

const load = (code: string, grants: string[], services = {}) => loadPlugin({ manifest, code, grants: grantsFrom(grants), services, createWorker: fakePluginWorker });

beforeEach(() => {
  __resetLedger();
  localStorage.clear();
  setAiPolicy("local-first");
});

describe("plugin host", () => {
  it("runs a plugin, routes a granted call to the app's service and returns its answer", async () => {
    const getText = vi.fn(async () => "hello");
    const logs: string[] = [];
    const p = await load(`lumen.document.getText().then((t) => console.log("text=" + t));`, ["document:read"], { "document.getText": getText });
    p.onLog((_, text) => logs.push(text));
    await vi.waitFor(() => expect(logs).toEqual(["text=hello"]));
    expect(getText).toHaveBeenCalledWith(expect.objectContaining({ id: "test.host" }));
    await p.unload();
    expect(p.alive).toBe(false);
  });

  it("grants are capped by the manifest: a grant the plugin never asked for does nothing", async () => {
    const write = vi.fn();
    const logs: string[] = [];
    const p = await load(`lumen.on("go", () => lumen.document.setText("x").catch((e) => console.log(e.name)));`, ["document:write"], { "document.setText": write });
    p.onLog((_, text) => logs.push(text));
    p.emit("go");
    await vi.waitFor(() => expect(logs).toEqual(["PluginDenied"]));
    expect(p.grants.size).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("a method with no service in this app is refused, not silently ignored", async () => {
    const logs: string[] = [];
    const p = await load(`lumen.panel.open({ title: "x" }).catch((e) => console.log("err " + e.message));`, ["panel"], {});
    p.onLog((_, text) => logs.push(text));
    await vi.waitFor(() => expect(logs[0]).toMatch(/not available/));
  });

  it("validates UI trees: the exfiltration kinds are refused before the app sees them", async () => {
    const render = vi.fn(async (_p: unknown, _tree: unknown) => undefined);
    const logs: string[] = [];
    const p = await load(
      `
      const trees = [
        { type: "box", children: [{ type: "text", text: "ok" }] },
        { type: "img", src: "https://evil.example/x.png" },
        { type: "link", href: "https://evil.example/?d" },
        { type: "iframe", src: "https://evil.example/" },
        { type: "form", action: "https://evil.example/" },
        { type: "style", text: "body{background:url(https://evil.example/)}" },
        { type: "script", text: "fetch('https://evil.example/')" },
        { type: "html", html: "<img src=https://evil.example/>" },
        { type: "noteLink", target: "https://evil.example/" },
        { type: "noteLink", target: "../../etc/passwd" },
        { type: "text", text: "x", onClick: "fetch" },
      ];
      Promise.all(trees.map((t) => lumen.panel.render(t).then(() => "ok", (e) => e.name))).then((r) => console.log(JSON.stringify(r)));
    `,
      ["panel"],
      { "panel.render": render },
    );
    p.onLog((_, text) => logs.push(text));
    await vi.waitFor(() => expect(logs.length).toBe(1));
    expect(JSON.parse(logs[0])).toEqual(["ok", ...new Array(10).fill("Error")]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][1]).toEqual({ type: "box", children: [{ type: "text", text: "ok" }] });
  });

  it("delivers command events and counts refusals on the host side too", async () => {
    const logs: string[] = [];
    const p = await load(
      `lumen.commands.register({ id: "go", label: "Go" }, () => lumen.document.getText().then((t) => console.log("ran " + t), (e) => console.log("ran " + e.name)));`,
      ["commands"],
      { "commands.register": async () => undefined },
    );
    p.onLog((_, text) => logs.push(text));
    p.emit("command:go", {});
    await vi.waitFor(() => expect(logs).toEqual(["ran PluginDenied"]));
  });

  it("a plugin that dies reports fatal and is terminated", async () => {
    const p = await load(`lumen.on("tick", () => { throw new Error("dead"); });`, []);
    const fatal = vi.fn();
    p.onFatal(fatal);
    p.emit("tick");
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(expect.stringMatching(/dead/)));
    expect(p.alive).toBe(false);
  });
});

describe("plugin network broker", () => {
  const plugin = { id: "test.host", grants: grantsFrom(["network:https://api.example.com"]) };
  const ok = (body = "{}", headers: Record<string, string> = { "content-type": "application/json" }) => new Response(body, { status: 200, headers });

  it("sends only to the granted origin, without credentials or redirects, and records it in the ledger", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok('{"a":1}'));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await pluginFetch(plugin, "https://api.example.com/v1/x", { method: "POST", body: "שלום", headers: { "content-type": "text/plain", cookie: "no", Authorization: "Bearer t" } });
    expect(r).toMatchObject({ status: 200, body: '{"a":1}' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/x");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", body: "שלום" });
    expect(init.headers).toEqual({ "content-type": "text/plain", Authorization: "Bearer t" });
    const e = ledgerEntries().at(-1)!;
    expect(e).toMatchObject({ category: "plugin", host: "api.example.com", decision: "allowed", method: "POST", bytesOut: 8, status: 200, bytesIn: 7, reason: "Plugin test.host" });
    vi.unstubAllGlobals();
  });

  it("refuses every other origin without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const u of ["https://evil.example.com/", "http://api.example.com/", "https://api.example.com.evil.com/", "https://api.example.com:8443/"]) {
      await expect(pluginFetch(plugin, u, {})).rejects.toMatchObject({ name: "PluginDenied" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledgerEntries()).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("under local-only the request is blocked, recorded as blocked and not sent", async () => {
    setAiPolicy("local-only");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(pluginFetch(plugin, "https://api.example.com/", {})).rejects.toMatchObject({ name: "PluginDenied" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledgerEntries().at(-1)).toMatchObject({ category: "plugin", decision: "blocked", policy: "local-only" });
    vi.unstubAllGlobals();
  });

  it("caps the response size", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok("x", { "content-length": String(MAX_RESPONSE_BYTES + 1) })));
    await expect(pluginFetch(plugin, "https://api.example.com/", {})).rejects.toThrow(/larger than/);
    vi.unstubAllGlobals();
  });
});
