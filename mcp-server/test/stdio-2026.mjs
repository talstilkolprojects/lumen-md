#!/usr/bin/env node
/**
 * A real stdio session in the 2026-07-28 protocol (plan W7.17), with raw
 * JSON lines — no SDK, so it runs from `dist/` alone:
 *   npm run build && node test/stdio-2026.mjs
 *
 * server/discover → tools/list → a write answers input_required → the
 * user approves → the retry completes; and a legacy initialize on a second
 * process still works. Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.LUMEN_MCP_DIST ? path.resolve(process.env.LUMEN_MCP_DIST) : path.join(here, "../dist");
const { enableClient } = await import(path.join(dist, "vault/config.js"));
const { approvePending, listPending } = await import(path.join(dist, "vault/pending.js"));

const vault = mkdtempSync(path.join(tmpdir(), "lumen-stdio26-"));
writeFileSync(path.join(vault, "hello.md"), "# Hello\n\nשלום עולם\n");
let failed = 0;
const check = (ok, msg) => {
  if (!ok) {
    failed++;
    console.error(`FAIL ${msg}`);
  } else console.log(`ok   ${msg}`);
};

function start() {
  const child = spawn(process.execPath, [path.join(dist, "index.js"), "--vault", vault, "--client", "smoke-26"], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const stray = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    const w = waiting.get(msg.id);
    if (w) {
      waiting.delete(msg.id);
      w(msg);
    } else stray.push(msg);
  });
  let id = 0;
  const send = (method, params, meta = true) =>
    new Promise((resolve) => {
      const rid = ++id;
      waiting.set(rid, resolve);
      const p = meta
        ? { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } }
        : params;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params: p }) + "\n");
    });
  return { child, send, stray };
}

try {
  await enableClient(vault, "smoke-26", ["search", "read", "propose"]);
  const s = start();
  const d = await s.send("server/discover", {});
  check(d.result?.supportedVersions?.[0] === "2026-07-28" && d.result.resultType === "complete", "server/discover");
  const l = await s.send("tools/list", {});
  check(l.result?.tools?.length === 11 && l.result.cacheScope === "private" && typeof l.result.ttlMs === "number", "tools/list: 11 tools, ttlMs, cacheScope private");
  const r = await s.send("tools/call", { name: "read_note", arguments: { path: "hello.md" } });
  check(r.result?.content?.[0]?.text.includes("שלום"), "read_note over stdio (Hebrew intact)");
  const call = { name: "create_note", arguments: { path: "from-agent.md", content: "# From an agent\n" } };
  const w = await s.send("tools/call", call);
  check(w.result?.resultType === "input_required" && typeof w.result.requestState === "string", "write → input_required");
  check(!existsSync(path.join(vault, "from-agent.md")), "nothing written before approval");
  const [p] = await listPending(vault);
  await approvePending(vault, p.id, "smoke");
  const done = await s.send("tools/call", { ...call, requestState: w.result.requestState });
  check(done.result?.resultType === "complete" && !done.result.isError, "retry after approval → complete");
  check(existsSync(path.join(vault, "from-agent.md")) && readFileSync(path.join(vault, "from-agent.md"), "utf8") === "# From an agent\n", "the approved note is on disk");
  const bad = await s.send("tools/list", {}, false);
  check(bad.error?.code === -32602, "no _meta and no handshake → -32602");
  const v = await s.send("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {} } }, false);
  check(v.error?.code === -32022 && v.error.data?.supported?.includes("2026-07-28"), "unknown version → -32022 with the supported list");
  check(s.stray.length === 0, "no unsolicited messages on stdout (no notifications/message)");
  s.child.stdin.end();

  const legacy = start();
  const init = await legacy.send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } }, false);
  check(init.result?.protocolVersion === "2025-11-25", "legacy initialize on a second process");
  const ll = await legacy.send("tools/list", {}, false);
  check(ll.result?.tools?.length === 11 && ll.result.resultType === undefined, "legacy tools/list");
  legacy.child.stdin.end();
} finally {
  rmSync(vault, { recursive: true, force: true });
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("stdio 2026-07-28: all passed");
