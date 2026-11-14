/**
 * Plan 11.2 — the plugin logic sandbox (QuickJS). Every capability is denied
 * by default and tested as denied; the sandbox has no I/O of its own; the
 * limits (heap, CPU, log rate) hold; granted calls reach the host.
 */
import { describe, it, expect, vi } from "vitest";
import { createSandbox, type SandboxHost } from "../plugins/runtime/sandbox";
import { grantsFrom, METHOD_CAPABILITY, NO_GRANTS } from "../plugins/runtime/capabilities";
import { CAPABILITIES, parseManifest } from "../plugins/runtime/manifest";

const manifest = parseManifest({
  schema: 1,
  id: "test.plugin",
  name: "Test",
  version: "1.0.0",
  description: "d",
  author: "a",
  license: "MIT",
  main: "main.js",
  capabilities: [...CAPABILITIES.map((id) => ({ id, reason: "test" })), { id: "network:https://api.example.com", reason: "test" }],
});

function host(): SandboxHost & { calls: [string, unknown[]][]; logs: string[]; fatals: string[] } {
  const h = {
    calls: [] as [string, unknown[]][],
    logs: [] as string[],
    fatals: [] as string[],
    call: vi.fn(async (method: string, args: unknown[]) => {
      h.calls.push([method, args]);
      return `ok:${method}`;
    }),
    log: (level: string, text: string) => void h.logs.push(`${level}:${text}`),
    fatal: (e: string) => void h.fatals.push(e),
  };
  return h;
}

/** Load `code` whose last statement stores its result in globalThis.__out, then read it back through a log. */
const boot = async (code: string, grants = NO_GRANTS, limits = {}) => {
  const h = host();
  const sb = await createSandbox({ manifest, code, grants, host: h, limits });
  return { sb, h };
};

describe("plugin sandbox — isolation", () => {
  it("has no I/O: fetch, XMLHttpRequest, WebSocket, importScripts, indexedDB, document, window are all undefined", async () => {
    const { h } = await boot(`
      const names = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "localStorage", "document", "window", "navigator", "Worker", "postMessage", "setTimeout"];
      console.log(JSON.stringify(names.filter((n) => typeof globalThis[n] !== "undefined")));
    `);
    expect(h.logs).toEqual(["log:[]"]);
  });
  it("cannot import other modules", async () => {
    await expect(boot(`import x from "./other.js"; console.log(x);`)).rejects.toThrow(/failed to load/);
  });
  it("cannot redefine the lumen API or reach the call bridge after boot", async () => {
    const { h } = await boot(`
      let changed = false;
      try { globalThis.lumen = {}; changed = globalThis.lumen !== lumen; } catch {}
      try { lumen.document.getText = () => "x"; } catch {}
      console.log(JSON.stringify({ changed, bridge: typeof __lumen_methods, frozen: Object.isFrozen(lumen.document) }));
    `);
    expect(JSON.parse(h.logs[0].slice(4))).toEqual({ changed: false, bridge: "undefined", frozen: true });
  });
});

describe("plugin sandbox — default deny", () => {
  const methods = Object.keys(METHOD_CAPABILITY);
  it.each(methods)("%s is refused without its capability and never reaches the host", async (method) => {
    const [ns, fn] = method.split(".");
    const arg = method === "network.fetch" ? '"https://api.example.com/x"' : method === "commands.register" ? '{ id: "c", label: "C" }' : '"a"';
    const { sb, h } = await boot(`
      lumen.${ns}.${fn}(${arg}).then(() => console.log("allowed"), (e) => console.log("denied " + e.name));
    `);
    await vi.waitFor(() => expect(h.logs.length).toBe(1));
    expect(h.logs[0]).toBe("log:denied PluginDenied");
    expect(h.call).not.toHaveBeenCalled();
    const cap = METHOD_CAPABILITY[method] === "network" ? "network:https://api.example.com" : METHOD_CAPABILITY[method];
    expect(sb.denied.get(cap)).toBe(1);
    sb.dispose();
  });
  it("a granted call reaches the host with JSON arguments and returns its value", async () => {
    const { sb, h } = await boot(`lumen.document.insertText("שלום", { at: 3 }).then((v) => console.log("got " + v));`, grantsFrom(["document:write"]));
    await vi.waitFor(() => expect(h.logs.length).toBe(1));
    expect(h.logs[0]).toBe("log:got ok:document.insertText");
    expect(h.calls).toEqual([["document.insertText", ["שלום", { at: 3 }]]]);
    sb.dispose();
  });
  it("a network grant covers its exact origin only — not another origin, a subdomain, or http", async () => {
    const grants = grantsFrom(["network:https://api.example.com"]);
    const { sb, h } = await boot(
      `
      const urls = ["https://api.example.com/v1", "https://evil.example.com/", "https://sub.api.example.com/", "http://api.example.com/", "https://api.example.com@evil.com/", "ftp://api.example.com/"];
      Promise.all(urls.map((u) => lumen.network.fetch(u).then(() => "ok", (e) => e.name))).then((r) => console.log(JSON.stringify(r)));
    `,
      grants,
    );
    await vi.waitFor(() => expect(h.logs.length).toBe(1));
    expect(JSON.parse(h.logs[0].slice(4))).toEqual(["ok", "PluginDenied", "PluginDenied", "PluginDenied", "PluginDenied", "PluginDenied"]);
    expect(h.calls.map((c) => c[1][0])).toEqual(["https://api.example.com/v1"]);
    sb.dispose();
  });
  it("a host refusal is a PluginDenied inside the plugin as well", async () => {
    const h = host();
    h.call = vi.fn(async () => {
      const e = new Error("policy");
      e.name = "PluginDenied";
      throw e;
    });
    const sb = await createSandbox({ manifest, code: `lumen.document.getText().catch((e) => console.log(e.name + ":" + e.message));`, grants: grantsFrom(["document:read"]), host: h });
    await vi.waitFor(() => expect(h.logs.length).toBe(1));
    expect(h.logs[0]).toBe("log:PluginDenied:policy");
    sb.dispose();
  });
});

describe("plugin sandbox — events and limits", () => {
  it("delivers command events to the handler registered with the command", async () => {
    const { sb, h } = await boot(`lumen.commands.register({ id: "hello", label: "Hello" }, (p) => console.log("ran " + JSON.stringify(p)));`, grantsFrom(["commands"]));
    await vi.waitFor(() => expect(h.calls.length).toBe(1));
    await sb.dispatch("command:hello", { from: "palette" });
    expect(h.logs).toEqual(['log:ran {"from":"palette"}']);
    sb.dispose();
  });
  it("an infinite loop is interrupted by the CPU limit and ends the plugin", async () => {
    await expect(boot(`for (;;) {}`, NO_GRANTS, { cpuMsPerEntry: 50 })).rejects.toThrow(/interrupted|failed to load/);
  });
  it("an infinite loop in an event handler is interrupted and reported as fatal", async () => {
    const { sb, h } = await boot(`lumen.on("tick", () => { for (;;) {} });`, NO_GRANTS, { cpuMsPerEntry: 50 });
    await sb.dispatch("tick", null);
    expect(h.fatals.length).toBe(1);
    expect(h.fatals[0]).toMatch(/interrupted/);
  });
  it("the heap limit stops a plugin that allocates without end", async () => {
    await expect(boot(`const a = []; for (;;) a.push(new Array(1e6).fill(1));`, NO_GRANTS, { memoryBytes: 8 * 1024 * 1024, cpuMsPerEntry: 2000 })).rejects.toThrow(/failed to load/);
  });
  it("console output is rate-limited and truncated", async () => {
    const { h } = await boot(`for (let i = 0; i < 20; i++) console.log("x".repeat(5000));`, NO_GRANTS, { logLinesPerMinute: 5 });
    expect(h.logs.length).toBe(5);
    expect(h.logs[0].length).toBe(4 + 2000);
  });
  it("an uncaught error at load fails the load; after load it is fatal", async () => {
    await expect(boot(`throw new Error("boom")`)).rejects.toThrow(/boom/);
    const { sb, h } = await boot(`lumen.on("tick", () => { throw new Error("later"); });`);
    await sb.dispatch("tick", 1);
    expect(h.fatals[0]).toMatch(/later/);
  });
});
