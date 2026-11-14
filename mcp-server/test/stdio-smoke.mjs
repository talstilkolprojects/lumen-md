#!/usr/bin/env node
/**
 * Real stdio session against the built server (plan W2.3):
 *   npm run test:stdio        (from mcp-server/, after npm ci)
 *
 * 1. A client that is not enabled sees no tools and is refused.
 * 2. Enabled with search,read,propose: search over 10,000 notes < 300 ms
 *    (after the index is built), and a write is only a proposal — the
 *    note is not on disk until `approvePending`.
 * Exits non-zero on any failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { enableClient } from "../dist/vault/config.js";
import { approvePending, listPending } from "../dist/vault/pending.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vault = mkdtempSync(path.join(tmpdir(), "lumen-stdio-"));
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
};
const words = ["alpha", "beta", "gamma", "delta", "שלום", "עולם", "פגישה", "תקציב", "release", "design"];
for (let i = 0; i < 10_000; i++) {
  const dir = path.join(vault, "bulk", String(i % 50));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `n${i}.md`), `# Note ${i}\n\n${words[i % 10]} ${words[(i * 7) % 10]} item${i} ${"lorem ipsum dolor ".repeat(20)}\n`);
}

async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "../dist/index.js"), "--vault", vault, "--client", "smoke-test"], stderr: "ignore" });
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

try {
  let client = await connect();
  const tools0 = await client.listTools();
  if (tools0.tools.length !== 0) fail(`not enabled: expected 0 tools, got ${tools0.tools.length}`);
  const refused = await client.callTool({ name: "search_notes", arguments: { query: "beta" } });
  if (!refused.isError) fail("not enabled: search was not refused");
  await client.close();

  await enableClient(vault, "smoke-test", ["search", "read", "propose"]);
  client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log(`tools: ${names.join(", ")}`);
  let t0 = performance.now();
  await client.callTool({ name: "search_notes", arguments: { query: "תקציב" } });
  console.log(`first search (builds the index): ${(performance.now() - t0).toFixed(0)} ms`);
  const times = [];
  for (let k = 0; k < 5; k++) {
    t0 = performance.now();
    const r = await client.callTool({ name: "search_notes", arguments: { query: k % 2 ? "design item19" : "תקציב", limit: 20 } });
    times.push(performance.now() - t0);
    if (r.isError || !String(r.content[0].text).includes("bulk/")) fail("search returned no notes");
  }
  console.log(`search over 10,000 notes, round trip: ${times.map((t) => t.toFixed(0)).join(" / ")} ms`);
  if (Math.max(...times) >= 300) fail(`search ≥ 300 ms (${Math.max(...times).toFixed(0)})`);

  const w = await client.callTool({ name: "create_note", arguments: { path: "inbox/from-client.md", content: "# From the client\n" } });
  if (w.isError) fail(`create_note refused: ${w.content[0].text}`);
  if (existsSync(path.join(vault, "inbox/from-client.md"))) fail("the note was written without approval");
  const pending = await listPending(vault);
  if (pending.length !== 1) fail(`expected 1 proposal, got ${pending.length}`);
  else console.log("write → proposal only: note not on disk ✓");
  await approvePending(vault, pending[0].id, "smoke");
  if (readFileSync(path.join(vault, "inbox/from-client.md"), "utf8") !== "# From the client\n") fail("approved note not written");
  else console.log("approved → written ✓");
  await client.close();
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  rmSync(vault, { recursive: true, force: true });
}
console.log(process.exitCode ? "stdio smoke: FAILED" : "stdio smoke: OK");
