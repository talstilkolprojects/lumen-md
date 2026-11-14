/**
 * Plan 3.6.3: the CI health check of the signaling and collab servers,
 * against both running in-process, and its skip when nothing is configured.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain ESM script module, no types
import { checkCollabHealth } from "../../scripts/lib/collabHealth.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { createCollabServer } from "../../sync-server/collab-server.mjs";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { createServer: createSignalServer } = require(resolve(__dirname, "../../sync-server/server.js")) as any;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function signal(): Promise<string> {
  const srv = (await createSignalServer({ port: 0, heartbeatMs: 10_000 })) as { port: number; close(): Promise<void> };
  cleanup.push(() => srv.close());
  return `ws://127.0.0.1:${srv.port}`;
}

async function collab(accessKey = ""): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), "lumen-health-"));
  const app = createCollabServer({ port: 0, host: "127.0.0.1", dataDir, accessKey, backupIntervalMs: 0 });
  const port = await app.listen();
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanup.push(() => app.close());
  return `ws://127.0.0.1:${port}`;
}

describe("collab health check", () => {
  it("skips when no endpoint is configured", async () => {
    expect(await checkCollabHealth({})).toEqual({ skipped: true, results: [] });
  });

  it("passes against healthy signaling and collab servers (open or with an access key)", async () => {
    const r = await checkCollabHealth({ signalUrl: await signal(), collabUrl: await collab("k".repeat(20)), timeoutMs: 3000 });
    expect(r.skipped).toBe(false);
    expect(r.results.map((x: { ok: boolean; error?: string }) => [x.ok, x.error])).toEqual([[true, undefined], [true, undefined]]);
    const open = await checkCollabHealth({ collabUrl: await collab(), timeoutMs: 3000 });
    expect(open.results[0].ok).toBe(true);
  });

  it("fails when a configured endpoint is down or is not the collab server", async () => {
    const r = await checkCollabHealth({ signalUrl: "ws://127.0.0.1:9", collabUrl: await signal(), timeoutMs: 2000 });
    expect(r.results.map((x: { ok: boolean }) => x.ok)).toEqual([false, false]);
    expect(r.results[1].error).toMatch(/not the Lumen collab server/);
  });
});
