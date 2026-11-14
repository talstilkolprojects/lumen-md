/**
 * The MCP protocol for the vault server, dual-era (plan W7.17).
 *
 * Modern (2026-07-28, https://modelcontextprotocol.io/specification/2026-07-28):
 *   • No handshake and no sessions. Every request carries
 *     `io.modelcontextprotocol/protocolVersion` and
 *     `io.modelcontextprotocol/clientCapabilities` in `params._meta`; a
 *     request without them is malformed (-32602). An unknown version gets
 *     UnsupportedProtocolVersion (-32022) with `data.supported`.
 *   • `server/discover` advertises versions, capabilities and identity.
 *   • Every result has `resultType`; lists carry `ttlMs` and
 *     `cacheScope: "private"` (the tool list depends on the client's
 *     grant); tools come in one fixed order.
 *   • A write that waits for the user returns `resultType:
 *     "input_required"` (Multi Round-Trip Requests) with a signed
 *     `requestState`; the client retries with it (vault/approval.ts).
 *   • Roots, Sampling and Logging are deprecated and not implemented; the
 *     server logs to stderr and never sends `notifications/message`.
 *
 * Legacy (2025-11-25 and earlier): `initialize` opens a legacy session
 * scoped to this stdio process, and requests are answered as before
 * (a write returns the proposal id as text). A dual-era server may serve
 * both on one process (spec: Versioning, "Backward Compatibility").
 *
 * Transport-free: `McpEndpoint.handle` takes one parsed JSON-RPC message
 * and returns the response (or null for a notification), so tests drive
 * exactly what stdio carries.
 */
import { normalizeClientId } from "./vault/config.js";
import { approvalOutcome, argsDigest, signState, StateError, verifyState } from "./vault/approval.js";
import { VaultIndex } from "./vault/search.js";
import { callTool, listToolsFor, toolDef, type ToolResult } from "./vault/tools.js";

export const SERVER_NAME = "lumen-mcp";
export const SERVER_VERSION = "0.3.0";
export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"];
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

/** JSON-RPC codes, and the MCP ones from the 2026-07-28 allocation (-32020…-32099). */
export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  missingClientCapability: -32021,
  unsupportedVersion: -32022,
} as const;

export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

/** Freshness hint for `tools/list`: short, because `lumen mcp enable/disable` changes it. */
export const TOOLS_TTL_MS = 10_000;
/** `server/discover` changes only with a new server version. */
export const DISCOVER_TTL_MS = 60 * 60 * 1000;

export const INSTRUCTIONS =
  "Lumen vault. Tools depend on what the user granted this client in Lumen (search, read, propose). " +
  "Write tools never write: they queue a change that the user approves in Lumen. " +
  "On a 2026-07-28 connection a write answers input_required; retry the same call with its requestState to learn the outcome.";

export type JsonRpcId = string | number;
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export interface EndpointOptions {
  vault: string;
  /** `--client` / LUMEN_MCP_CLIENT: the id the user's config names (preferred over what a client reports). */
  explicitClient?: string;
  index?: VaultIndex;
  /** stderr; never stdout (stdout is the protocol). */
  log?: (line: string) => void;
  now?: () => number;
}

type Era = { kind: "modern"; version: string; client: string; capabilities: Record<string, unknown> } | { kind: "legacy"; version: string; client: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const serverInfo = () => ({ name: SERVER_NAME, version: SERVER_VERSION });

export class McpEndpoint {
  readonly vault: string;
  readonly index: VaultIndex;
  private readonly explicitClient?: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  /** Set by a legacy `initialize`: the legacy session of this process. */
  private legacy: { version: string; clientName?: string } | null = null;

  constructor(o: EndpointOptions) {
    this.vault = o.vault;
    this.index = o.index ?? new VaultIndex(o.vault, { minRefreshMs: 1000 });
    this.explicitClient = o.explicitClient;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
  }

  /** One message in, its response out (null for notifications). Never throws. */
  async handle(raw: unknown): Promise<JsonRpcResponse | null> {
    if (Array.isArray(raw)) return fail(null, ERR.invalidRequest, "JSON-RPC batches are not supported.");
    if (!isObj(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
      const id = isObj(raw) && (typeof raw.id === "string" || typeof raw.id === "number") ? raw.id : null;
      // A response from the client (we send no requests) or garbage.
      if (isObj(raw) && raw.method === undefined && ("result" in raw || "error" in raw)) return null;
      return fail(id, ERR.invalidRequest, "Not a JSON-RPC 2.0 request.");
    }
    const req = raw as unknown as JsonRpcRequest;
    const isNotification = req.id === undefined;
    if (!isNotification && typeof req.id !== "string" && typeof req.id !== "number") return fail(null, ERR.invalidRequest, "Request id must be a string or a number.");
    if (isNotification) return null; // notifications/initialized, notifications/cancelled …: nothing to do.
    const id = req.id as JsonRpcId;
    try {
      return await this.dispatch(id, req.method, isObj(req.params) ? req.params : {});
    } catch (e) {
      this.log(`lumen-mcp: ${req.method} failed: ${(e as Error)?.stack ?? String(e)}`);
      return fail(id, ERR.internal, "Internal error.");
    }
  }

  private era(params: Record<string, unknown>): Era | { error: [number, string, unknown?] } {
    const meta = isObj(params._meta) ? params._meta : {};
    const version = meta[META.protocolVersion];
    if (version !== undefined) {
      if (typeof version !== "string" || !SUPPORTED_VERSIONS.includes(version)) {
        return { error: [ERR.unsupportedVersion, "Unsupported protocol version", { supported: [...SUPPORTED_VERSIONS], requested: version }] };
      }
      const info = isObj(meta[META.clientInfo]) ? (meta[META.clientInfo] as Record<string, unknown>) : {};
      const reported = typeof info.name === "string" ? info.name : this.legacy?.clientName;
      const client = normalizeClientId(this.explicitClient || reported || "unknown");
      if (LEGACY_VERSIONS.includes(version)) return { kind: "legacy", version, client };
      const caps = meta[META.clientCapabilities];
      if (!isObj(caps)) return { error: [ERR.invalidParams, `Missing _meta["${META.clientCapabilities}"] (required on every 2026-07-28 request).`] };
      return { kind: "modern", version, client, capabilities: caps };
    }
    if (this.legacy) return { kind: "legacy", version: this.legacy.version, client: normalizeClientId(this.explicitClient || this.legacy.clientName || "unknown") };
    return {
      error: [
        ERR.invalidParams,
        `Missing _meta["${META.protocolVersion}"]. This server speaks MCP ${SUPPORTED_VERSIONS.join(", ")}: send it on every request (2026-07-28) or call initialize first (2025-11-25 and earlier).`,
      ],
    };
  }

  private async dispatch(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (method === "initialize") return this.initialize(id, params);
    if (method === "server/discover") return this.discover(id, params);

    const era = this.era(params);
    if ("error" in era) {
      const [code, message, data] = era.error;
      return fail(id, code, message, data);
    }
    const e = era;
    switch (method) {
      case "ping":
        // Removed in 2026-07-28; still answered for legacy sessions.
        return e.kind === "legacy" ? ok(id, {}) : fail(id, ERR.methodNotFound, "ping was removed in MCP 2026-07-28.");
      case "tools/list":
        return this.toolsList(id, e);
      case "tools/call":
        return this.toolsCall(id, e, params);
      default:
        // Roots, Sampling, Logging (deprecated), resources, prompts,
        // subscriptions: this server offers none of them.
        return fail(id, ERR.methodNotFound, `Method not found: ${method}`);
    }
  }

  private initialize(id: JsonRpcId, params: Record<string, unknown>): JsonRpcResponse {
    const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const version = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0]!;
    const info = isObj(params.clientInfo) ? params.clientInfo : {};
    this.legacy = { version, clientName: typeof info.name === "string" ? info.name : undefined };
    return ok(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: serverInfo(), instructions: INSTRUCTIONS });
  }

  private discover(id: JsonRpcId, params: Record<string, unknown>): JsonRpcResponse {
    // A probe may come before the client knows our versions: a version we
    // do not speak is still an error that lists the ones we do.
    const meta = isObj(params._meta) ? params._meta : {};
    const v = meta[META.protocolVersion];
    if (v !== undefined && (typeof v !== "string" || !SUPPORTED_VERSIONS.includes(v))) {
      return fail(id, ERR.unsupportedVersion, "Unsupported protocol version", { supported: [...SUPPORTED_VERSIONS], requested: v });
    }
    return ok(id, {
      resultType: "complete",
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: { listChanged: false } },
      serverInfo: serverInfo(),
      instructions: INSTRUCTIONS,
      ttlMs: DISCOVER_TTL_MS,
      cacheScope: "private",
      _meta: { [META.serverInfo]: serverInfo() },
    });
  }

  private async toolsList(id: JsonRpcId, e: Era): Promise<JsonRpcResponse> {
    const tools = (await listToolsFor(this.vault, e.client)).map((t) => ({
      name: t.name,
      description: `${t.description} (scope: ${t.scope})`,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.scope !== "propose", destructiveHint: false, openWorldHint: false },
    }));
    if (e.kind === "legacy") return ok(id, { tools });
    return ok(id, { resultType: "complete", tools, ttlMs: TOOLS_TTL_MS, cacheScope: "private", _meta: { [META.serverInfo]: serverInfo() } });
  }

  private async toolsCall(id: JsonRpcId, e: Era, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) return fail(id, ERR.invalidParams, "tools/call needs a tool name.");
    const args = isObj(params.arguments) ? params.arguments : {};
    const def = toolDef(name);

    if (e.kind === "legacy") {
      const res = await callTool({ vault: this.vault, client: e.client, index: this.index }, name, args);
      return ok(id, toolBody(res));
    }

    const complete = (res: ToolResult) => ok(id, { resultType: "complete", ...toolBody(res), _meta: { [META.serverInfo]: serverInfo() } });

    // A retry of a write that waited for the user (MRTR).
    if (params.requestState !== undefined) {
      if (!def || def.scope !== "propose") return fail(id, ERR.invalidParams, "requestState is not one this server issued.");
      let pid: string;
      try {
        pid = (await verifyState(this.vault, params.requestState, { client: e.client, tool: def.name, args }, this.now())).pid;
      } catch (err) {
        if (err instanceof StateError) return fail(id, ERR.invalidParams, err.message);
        throw err;
      }
      // The client's inputResponses never approve anything: only the user's decision in Lumen does.
      const out = await approvalOutcome(this.vault, pid);
      switch (out.status) {
        case "pending":
          return this.inputRequired(id, e, params.requestState as string, def.name);
        case "approved":
          return complete({ content: [{ type: "text", text: `Written: the user approved the change to ${out.path ?? "the note"} (id ${pid}).` }] });
        case "rejected":
          return complete({ content: [{ type: "text", text: `The user rejected the change to ${out.path ?? "the note"} (id ${pid}). Nothing was written.` }], isError: true });
        case "conflict":
          return complete({
            content: [{ type: "text", text: `Not written: ${out.reason ?? "the note changed"} (id ${pid}). Read the note again and propose the change again.` }],
            isError: true,
          });
        default:
          return complete({ content: [{ type: "text", text: `Lumen has no record of proposal ${pid}. Nothing was written.` }], isError: true });
      }
    }

    const res = await callTool({ vault: this.vault, client: e.client, index: this.index }, name, args);
    if (!res.proposalId || !def) return complete(res);
    const state = await signState(this.vault, { pid: res.proposalId, client: e.client, tool: def.name, digest: argsDigest(args) }, this.now());
    return this.inputRequired(id, e, state, def.name);
  }

  private inputRequired(id: JsonRpcId, e: Extract<Era, { kind: "modern" }>, requestState: string, tool: string): JsonRpcResponse {
    const result: Record<string, unknown> = { resultType: "input_required", requestState, _meta: { [META.serverInfo]: serverInfo() } };
    // Only when the client declared elicitation (MRTR rule 7). The answer is
    // ignored: it only tells the client when to retry.
    if (isObj(e.capabilities.elicitation)) {
      result.inputRequests = {
        lumen_approval: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: `Lumen is waiting for you to approve this change (${tool}) in Lumen's review screen, or with \`lumen mcp review\`. Continue once you have decided.`,
            requestedSchema: { type: "object", properties: {} },
          },
        },
      };
    }
    return ok(id, result);
  }
}

function toolBody(res: ToolResult): Record<string, unknown> {
  return { content: res.content, ...(res.isError ? { isError: true } : {}) };
}

function ok(id: JsonRpcId, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}
