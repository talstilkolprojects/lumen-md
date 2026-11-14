/**
 * Plan 3.6: connectCollab against the real Hocuspocus collab server (in
 * process), WebRTC stubbed out, so everything goes through the server. Two
 * sessions in an end-to-end encrypted room edit, both leave, the server
 * restarts on the same storage, and a third session gets the content.
 * The server runs as a Node child process. Node environment: jsdom's
 * Event class breaks Node's own WebSocket, which the providers use here.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});

vi.mock("y-webrtc", () => ({
  WebrtcProvider: class {
    room = { webrtcConns: new Map() };
    awareness = { getStates: () => new Map([[1, {}]]), setLocalStateField: () => {} };
    on() {}
    off() {}
    destroy() {}
  },
}));
vi.mock("../lib/secretStore", () => ({ getSecret: (k: string) => (k === "lumen.collab.wsToken" ? "rt-access-key" : null) }));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  localStorage.removeItem("lumen.collab.ws");
});

interface Running {
  proc: ChildProcess;
  stop(): Promise<void>;
}

/** Start sync-server/collab-server.mjs on an ephemeral port and point the client at it. */
function start(dataDir: string): Promise<Running> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", resolve(__dirname, "../../sync-server/collab-server.mjs")], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", COLLAB_DATA_DIR: dataDir, COLLAB_ACCESS_KEY: "rt-access-key", COLLAB_DEBOUNCE_MS: "20" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = () =>
    proc.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((r) => {
          proc.once("exit", () => r());
          proc.kill("SIGTERM");
        });
  return new Promise((ok, fail) => {
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = out.match(/listening on :(\d+)/);
      if (m) {
        localStorage.setItem("lumen.collab.ws", `ws://127.0.0.1:${m[1]}`);
        ok({ proc, stop });
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.once("exit", (code) => fail(new Error(`collab server exited (${code}): ${out}`)));
  });
}

describe("persistent collab round trip", () => {
  it("keeps an encrypted room's edits after everyone leaves and the server restarts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lumen-rt-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    let server = await start(dataDir);
    cleanup.push(() => server.stop());
    const { connectCollab } = await import("../collab/yjs");
    const room = "lumen-0123456789abcdef0123456789abcdef";
    const password = "rt-room-password";

    const a = connectCollab(room, "seed\n", { password, isNewRoom: true });
    await vi.waitFor(() => expect(a.websocketProvider?.synced).toBe(true), { timeout: 5000 });
    a.ytext.insert(0, "alpha ");
    const b = connectCollab(room, "other local text", { password });
    await vi.waitFor(() => expect(b.ytext.toString()).toBe("alpha seed\n"), { timeout: 5000 });
    b.ytext.insert(b.ytext.length, "beta");
    await vi.waitFor(() => expect(a.ytext.toString()).toBe("alpha seed\nbeta"), { timeout: 5000 });
    a.destroy();
    b.destroy();
    await server.stop();

    server = await start(dataDir);
    const c = connectCollab(room, "c local text", { password });
    cleanup.push(() => c.destroy());
    await vi.waitFor(() => expect(c.ytext.toString()).toBe("alpha seed\nbeta"), { timeout: 5000 });
  });
});
