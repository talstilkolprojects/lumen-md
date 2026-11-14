/**
 * Plan W7.18 — the local agent uses the right MCP tool: 10 golden
 * scenarios against two local servers (Lumen's own vault server, and a
 * Knesset-like server with Knessy's tool names), on a real local model.
 * Target: the first tool called is the expected one in ≥ 9 of 10.
 * Start it with `npm run eval:mcp-client` (it sets LUMEN_EVAL_MCP=1).
 *
 *   LUMEN_EVAL_OLLAMA_URL  default http://localhost:11434
 *   LUMEN_EVAL_MODEL       default qwen2.5:7b
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { McpEndpoint } from "../../../mcp-server/src/protocol";
import { enableClient } from "../../../mcp-server/src/vault/config";
import type { JsonRpcMessage, McpTransport } from "../mcp/client";
import { agentToolName, serverAgentTools } from "../mcp/tools";
import type { McpServerConfig } from "../mcp/servers";
import { runAgent } from "../runtime";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";

const KNESSET_TOOLS = [
  { name: "search_bills", description: "Search Knesset bills by words, status or Knesset number.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_bill_details", description: "Details of one bill by its id.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { bill_id: { type: "number" } }, required: ["bill_id"] } },
  { name: "get_bill_votes", description: "How members voted on a bill.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { bill_id: { type: "number" } }, required: ["bill_id"] } },
  { name: "search_protocols", description: "Search committee meeting protocols.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const knesset: McpTransport = {
  reach: "local",
  async send(m: JsonRpcMessage) {
    if (m.id === undefined) return { message: null };
    if (m.method === "server/discover") return { message: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "knesset" } } } };
    if (m.method === "tools/list") return { message: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", tools: KNESSET_TOOLS } } };
    return { message: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", content: [{ type: "text", text: "[]" }] } } };
  },
};

const SCENARIOS: Array<[string, string, string]> = [
  ["חפש בפתקים שלי את המילה תקציב", "vault", "search_notes"],
  ["קרא את הפתק projects/launch.md", "vault", "read_note"],
  ["אילו תגיות יש בכספת שלי?", "vault", "list_tags"],
  ["אילו פתקים מקשרים לפתק launch?", "vault", "get_backlinks"],
  ["Find bills about public transport in the Knesset", "knesset", "search_bills"],
  ["מצא הצעות חוק על דיור ציבורי", "knesset", "search_bills"],
  ["How did the members vote on bill 2241?", "knesset", "get_bill_votes"],
  ["תן לי את הפרטים של הצעת חוק 1873", "knesset", "get_bill_details"],
  ["חפש בפרוטוקולים של ועדת החינוך את המילה תקציב", "knesset", "search_protocols"],
  ["List every note in my vault", "vault", "list_notes"],
];

// skip-reason: an opt-in eval against a real local model (npm run eval:mcp-client), not a unit test | task: W7.18 | until: 2027-05-14
describe.skipIf(!process.env.LUMEN_EVAL_MCP)(`MCP client tool choice — ${model} @ ${url}`, () => {
  it("picks the expected tool in ≥ 9 of 10 scenarios", async () => {
    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");
    const vault = mkdtempSync(path.join(tmpdir(), "lumen-mcp-eval-"));
    writeFileSync(path.join(vault, "launch.md"), "# Launch\n\nתקציב ההשקה.\n");
    await enableClient(vault, "lumen", ["search", "read"]);
    const ep = new McpEndpoint({ vault });
    const vaultT: McpTransport = { reach: "local", send: async (m) => ({ message: await ep.handle(m) }) };
    const cfg = (id: string): McpServerConfig => ({ id, label: id, transport: "http", url: "http://127.0.0.1/mcp", enabled: true, defaultPermission: "read", tools: {} });
    const o = { reach: () => ({ airplane: false, localOnly: true, desktop: true }), confirmCall: () => true };
    const tools = [...(await serverAgentTools(cfg("vault"), () => vaultT, o)), ...(await serverAgentTools(cfg("knesset"), () => knesset, o))];
    let right = 0;
    const misses: string[] = [];
    for (const [ask, server, tool] of SCENARIOS) {
      const run = await runAgent({ id: "mcp-eval", description: "Use the MCP tools to answer.", system: "Answer the user's request using the tools.", user: (i) => i.text ?? "", tools, maxSteps: 2, maxRetries: 0, executorPreference: ["ollama"] }, { text: ask });
      const first = run.steps.find((s) => s.kind === "tool")?.label;
      if (first === agentToolName(server, tool)) right++;
      else misses.push(`${ask} → ${first ?? "no tool"}`);
    }
    expect(right, misses.join("\n")).toBeGreaterThanOrEqual(9);
  }, 3_600_000);
});
