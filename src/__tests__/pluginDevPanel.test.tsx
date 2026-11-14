/**
 * Plan W3.10 — the developer panel: connects to the dev server, shows the
 * reload time, CPU and memory, and the capabilities the plugin asked for
 * against the ones it used (and any it used without asking).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { DevPanel } from "../plugins/runtime/DevPanel";
import type { DevConnection, DevStatus } from "../plugins/runtime/devPlugin";
import type { PluginInstance } from "../plugins/runtime/pluginHost";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeConnection(urls: string[]) {
  const listeners = new Set<(s: DevStatus) => void>();
  const instance = {
    calls: [
      { at: 1, method: "document.getText", capability: "document:read", ms: 0.4, outcome: "ok" },
      { at: 2, method: "vault.list", capability: "vault:read", ms: 1.2, outcome: "denied" },
    ],
    capabilityUse: new Map([["document:read", 3]]),
    denied: new Map([["vault:read", 1]]),
    stats: { cpuMs: 12.4, entries: 5, maxEntryMs: 4.1, memoryBytes: 2 * 1024 * 1024, denied: { panel: 2 } },
    loadMs: 8,
    onActivity: () => () => {},
  } as unknown as PluginInstance;
  let status: DevStatus = {
    url: "http://127.0.0.1:5199",
    state: "running",
    manifest: { schema: 1, id: "local.x", name: "My plugin", version: "0.1.0", description: "", author: "", license: "MIT", main: "main.js", capabilities: [{ id: "document:read", reason: "" }, { id: "panel", reason: "" }] },
    instance,
    reloads: 1,
    lastReloadMs: 42.5,
    scan: null,
    error: null,
  };
  let reloads = 0;
  const conn: DevConnection = {
    get status() {
      return status;
    },
    onChange: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    reload: async () => {
      reloads++;
      status = { ...status, reloads: status.reloads + 1, lastReloadMs: 30 };
      for (const f of listeners) f(status);
    },
    close: async () => {},
  };
  return { connect: async (u: string) => (urls.push(u), conn), reloads: () => reloads };
}

describe("plugin developer panel (W3.10)", () => {
  it("connects and shows reload time, CPU, memory and the capability table", async () => {
    const urls: string[] = [];
    const f = fakeConnection(urls);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(DevPanel, { connect: f.connect })));
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Connect")!;
    await act(async () => button.click());
    expect(urls).toEqual(["http://127.0.0.1:5199"]);
    expect(host.querySelector('[data-testid="plugin-dev-reload"]')!.textContent).toBe("Reloads: 1 · last reload 42.5 ms · start 8 ms");
    expect(host.querySelector('[data-testid="plugin-dev-stats"]')!.textContent).toBe("CPU 12 ms in 5 runs (longest 4 ms) · memory 2.0 MB");
    const rows = [...host.querySelectorAll('[data-testid="plugin-dev-caps"] tbody tr')].map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toEqual([
      ["document:read", "3", "0"],
      ["panel (never used)", "0", "2"],
    ]);
    expect(host.querySelectorAll('[data-testid="plugin-dev-calls"] li').length).toBe(2);
    const reload = [...host.querySelectorAll("button")].find((b) => b.textContent === "Reload")!;
    await act(async () => reload.click());
    expect(f.reloads()).toBe(1);
    expect(host.querySelector('[data-testid="plugin-dev-reload"]')!.textContent).toContain("Reloads: 2 · last reload 30 ms");
    await act(async () => root.unmount());
  });

  it("shows why it could not connect", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(DevPanel, { connect: async () => Promise.reject(new Error("developer mode connects only to this computer (localhost / 127.0.0.1)")) })));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Connect")!.click());
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Could not connect: developer mode connects only to this computer (localhost / 127.0.0.1)");
    await act(async () => root.unmount());
  });
});
