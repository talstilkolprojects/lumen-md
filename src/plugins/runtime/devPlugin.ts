/**
 * Developer mode (plan W3.10): run a plugin from its dev server
 * (`npm run dev` in a folder made by `npx create-lumen-plugin`, at
 * http://127.0.0.1:5199) and reload it whenever a file changes. The dev
 * server sends `change` on /events; the app fetches the manifest and
 * main.js again, scans them (W1.20 — findings are shown, not enforced:
 * it is your own code), and restarts the plugin with the capabilities
 * the manifest asks for. Only loopback addresses are accepted.
 */
import type { PluginManifest } from "./manifest";
import type { PluginInstance } from "./pluginHost";
import type { ScanResult } from "./scan";
import { UserFacingError } from "../../lib/userError";

export const DEFAULT_DEV_URL = "http://127.0.0.1:5199";

export interface DevStatus {
  url: string;
  state: "connecting" | "running" | "error" | "closed";
  manifest: PluginManifest | null;
  instance: PluginInstance | null;
  reloads: number;
  /** From the change event to the plugin running again, ms. */
  lastReloadMs: number | null;
  scan: ScanResult | null;
  error: string | null;
}

export interface DevDeps {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  EventSource: new (url: string) => { addEventListener(type: string, fn: (e: { data?: string }) => void): void; close(): void; onerror: ((e: unknown) => void) | null };
  start: (opts: { manifest: PluginManifest; code: string; grants: Set<string> }) => Promise<PluginInstance>;
  stop: (id: string) => Promise<void>;
  scan: (input: { manifest: PluginManifest; main: string }) => Promise<ScanResult>;
  parse: (json: string) => PluginManifest;
  now: () => number;
}

/** Only the developer's own computer: http(s)://localhost / 127.0.0.1 / [::1], any port. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

async function defaultDeps(): Promise<DevDeps> {
  const [{ startPlugin, stopPlugin }, { scanPluginVersion }, { parseManifest }] = await Promise.all([import("./manager"), import("./scan"), import("./manifest")]);
  return {
    // privacy-ledger: not tracked — developer mode only; connectDevPlugin refuses any URL that is not this computer (isLoopbackUrl), no credentials.
    fetch: (u) => fetch(u, { cache: "no-store", credentials: "omit" }),
    EventSource: EventSource as unknown as DevDeps["EventSource"],
    start: (o) => startPlugin({ manifest: o.manifest, code: o.code, grants: o.grants as never }),
    stop: stopPlugin,
    scan: (i) => scanPluginVersion(i),
    parse: (j) => parseManifest(j),
    now: () => performance.now(),
  };
}

export interface DevConnection {
  readonly status: DevStatus;
  onChange(fn: (s: DevStatus) => void): () => void;
  /** Reload now (as a change event would). */
  reload(): Promise<void>;
  close(): Promise<void>;
}

export async function connectDevPlugin(rawUrl: string, deps?: Partial<DevDeps>): Promise<DevConnection> {
  const url = rawUrl.trim().replace(/\/+$/, "");
  if (!isLoopbackUrl(url)) throw new UserFacingError("developer mode connects only to this computer (localhost / 127.0.0.1)");
  const d: DevDeps = { ...(await defaultDeps().catch(() => ({}) as DevDeps)), ...deps } as DevDeps;
  const status: DevStatus = { url, state: "connecting", manifest: null, instance: null, reloads: 0, lastReloadMs: null, scan: null, error: null };
  const listeners = new Set<(s: DevStatus) => void>();
  const changed = () => {
    for (const f of listeners) f({ ...status });
  };
  let running: Promise<void> = Promise.resolve();
  let again = false;
  let busy = false;

  const get = async (path: string) => {
    // privacy-ledger: not tracked — `url` passed isLoopbackUrl (localhost / 127.0.0.1 / [::1]): the developer's own dev server.
    const res = await d.fetch(`${url}/${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.text();
  };

  const load = async (t0: number) => {
    const manifest = d.parse(await get("lumen-plugin.json"));
    const code = await get(manifest.main.replace(/^\.?\//, ""));
    status.scan = await d.scan({ manifest, main: code }).catch(() => null);
    if (status.manifest && status.manifest.id !== manifest.id) await d.stop(status.manifest.id);
    status.instance = await d.start({ manifest, code, grants: new Set(manifest.capabilities.map((c) => c.id)) });
    status.manifest = manifest;
    status.state = "running";
    status.error = null;
    status.reloads++;
    status.lastReloadMs = Math.round((d.now() - t0) * 10) / 10;
    changed();
  };

  /** One reload at a time; a change during a reload runs one more after it. */
  const reload = (t0 = d.now()): Promise<void> => {
    if (busy) {
      again = true;
      return running;
    }
    busy = true;
    running = (async () => {
      try {
        await load(t0);
      } catch (e) {
        status.state = "error";
        status.error = e instanceof Error ? e.message : String(e);
        changed();
      } finally {
        busy = false;
      }
      if (again) {
        again = false;
        await reload();
      }
    })();
    return running;
  };

  await reload();
  const es = new d.EventSource(`${url}/events`);
  es.addEventListener("change", () => void reload(d.now()));
  es.onerror = () => {
    if (status.state !== "closed" && status.state !== "error") {
      status.error = "the dev server is not reachable (is `npm run dev` running?)";
      changed();
    }
  };

  return {
    get status() {
      return { ...status };
    },
    onChange: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    reload: () => reload(),
    async close() {
      es.close();
      status.state = "closed";
      if (status.manifest) await d.stop(status.manifest.id);
      status.instance = null;
      changed();
    },
  };
}
