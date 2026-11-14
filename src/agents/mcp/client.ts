/**
 * Lumen as an MCP client (plan W7.18): the local agents use tools of
 * outside MCP servers. Dual-era, like our server (W7.17):
 *
 *   • 2026-07-28 first: every request carries the protocol version, the
 *     client's capabilities and identity in `_meta`; `server/discover`
 *     probes the server; results carry `resultType` (absent = "complete").
 *   • A server that answers the probe with anything but a modern result or
 *     error is legacy (2025-11-25 and earlier): `initialize`, then
 *     `notifications/initialized`, then requests in its session
 *     (Streamable HTTP: the `Mcp-Session-Id` header).
 *
 * We declare no client capabilities (no elicitation, sampling or roots), so
 * a server cannot ask the user anything through us; an `input_required`
 * answer is reported to the agent as "needs the user", never fulfilled.
 */

export const CLIENT_INFO = { name: "lumen", version: "1" } as const;
export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** One request in, its response out (null for a notification). */
export interface McpTransport {
  /** "local": stdio or a loopback address; "remote": anything else (blocked in airplane mode). */
  readonly reach: "local" | "remote";
  send(msg: JsonRpcMessage, meta: { protocolVersion: string; sessionId?: string }): Promise<{ message: JsonRpcMessage | null; sessionId?: string }>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export type McpCallResult =
  | { kind: "complete"; text: string; isError: boolean; structured?: unknown }
  | { kind: "input_required"; text: string };

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

const MODERN_ERRORS = new Set([-32020, -32021, -32022]);

type ServerInfo = { name?: string; version?: string };

export class McpClient {
  era: "modern" | "legacy" | null = null;
  private version = MODERN;
  private sessionId?: string;
  private seq = 0;
  serverInfo: ServerInfo = {};
  instructions?: string;

  constructor(readonly transport: McpTransport) {}

  private meta(): Record<string, unknown> {
    return { "io.modelcontextprotocol/protocolVersion": this.version, "io.modelcontextprotocol/clientInfo": CLIENT_INFO, "io.modelcontextprotocol/clientCapabilities": {} };
  }

  private async raw(method: string, params: Record<string, unknown> = {}, notify = false): Promise<JsonRpcMessage | null> {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", method, params, ...(notify ? {} : { id: ++this.seq }) };
    const r = await this.transport.send(msg, { protocolVersion: this.version, sessionId: this.sessionId });
    if (r.sessionId) this.sessionId = r.sessionId;
    return r.message;
  }

  /** Decide the server's era once (spec: Versioning, backward compatibility). */
  async connect(): Promise<void> {
    if (this.era) return;
    let probe: JsonRpcMessage | null = null;
    try {
      probe = await this.raw("server/discover", { _meta: this.meta() });
    } catch {
      probe = null;
    }
    if (probe?.result && Array.isArray(probe.result.supportedVersions)) {
      const v = probe.result.supportedVersions as string[];
      if (!v.includes(MODERN)) throw new McpClientError(`the server speaks ${v.join(", ")}, not ${MODERN}`);
      this.era = "modern";
      this.serverInfo = (probe.result.serverInfo as ServerInfo | undefined) ?? {};
      this.instructions = typeof probe.result.instructions === "string" ? probe.result.instructions : undefined;
      return;
    }
    if (probe?.error && MODERN_ERRORS.has(probe.error.code)) {
      const supported = (probe.error.data as { supported?: string[] } | undefined)?.supported ?? [];
      throw new McpClientError(`the server does not speak ${MODERN} (it speaks ${supported.join(", ") || "something else"})`, probe.error.code);
    }
    // Legacy server: the handshake.
    this.version = LEGACY;
    const init = await this.raw("initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: CLIENT_INFO });
    if (!init?.result) throw new McpClientError(`initialize failed: ${init?.error?.message ?? "no answer"}`, init?.error?.code);
    this.version = typeof init.result.protocolVersion === "string" ? init.result.protocolVersion : LEGACY;
    this.serverInfo = (init.result.serverInfo as ServerInfo | undefined) ?? {};
    this.instructions = typeof init.result.instructions === "string" ? init.result.instructions : undefined;
    await this.raw("notifications/initialized", {}, true);
    this.era = "legacy";
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    const res = await this.raw(method, this.era === "modern" ? { ...params, _meta: this.meta() } : params);
    if (!res) throw new McpClientError(`${method}: no answer`);
    if (res.error) throw new McpClientError(`${method}: ${res.error.message}`, res.error.code);
    const result = res.result ?? {};
    const type = result.resultType ?? "complete";
    if (type !== "complete" && type !== "input_required") throw new McpClientError(`${method}: unknown resultType "${String(type)}"`);
    return result;
  }

  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      for (const t of (r.tools as McpTool[] | undefined) ?? []) if (t && typeof t.name === "string") out.push(t);
      cursor = typeof r.nextCursor === "string" ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.resultType === "input_required") return { kind: "input_required", text: "The server needs the user's input to finish this (it was not given)." };
    const content = Array.isArray(r.content) ? (r.content as Array<{ type?: string; text?: string }>) : [];
    const text = content
      .map((c) => (c.type === "text" ? String(c.text ?? "") : `[${c.type ?? "content"} not shown]`))
      .join("\n")
      .slice(0, 50_000);
    return { kind: "complete", text, isError: r.isError === true, ...(r.structuredContent !== undefined ? { structured: r.structuredContent } : {}) };
  }
}

/** Is this URL on this machine (localhost, 127.0.0.0/8, ::1)? */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

/**
 * Streamable HTTP (spec 2026-07-28): POST one JSON-RPC message; the answer
 * is JSON or an SSE stream whose `data:` lines carry it. Standard headers:
 * MCP-Protocol-Version, Mcp-Method, Mcp-Name; Mcp-Session-Id for legacy.
 */
export function httpTransport(url: string, fetchImpl: () => typeof fetch, headers: () => Record<string, string> = () => ({})): McpTransport {
  return {
    reach: isLoopbackUrl(url) ? "local" : "remote",
    async send(msg, meta) {
      const name = typeof msg.params?.name === "string" ? (msg.params.name as string) : undefined;
      const res = await fetchImpl()(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": meta.protocolVersion,
          ...(msg.method ? { "Mcp-Method": msg.method } : {}),
          ...(name ? { "Mcp-Name": name } : {}),
          ...(meta.sessionId ? { "Mcp-Session-Id": meta.sessionId } : {}),
          ...headers(),
        },
        body: JSON.stringify(msg),
        // Never follow a redirect: it would carry the tool's arguments to another address (review 21, C3).
        redirect: "error",
      });
      const sessionId = res.headers.get("Mcp-Session-Id") ?? undefined;
      if (msg.id === undefined) return { message: null, sessionId };
      const type = res.headers.get("Content-Type") ?? "";
      const body = await res.text();
      let message: JsonRpcMessage | null = null;
      if (type.includes("text/event-stream")) {
        for (const line of body.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const m = JSON.parse(line.slice(5).trim()) as JsonRpcMessage;
            if (m.id === msg.id) message = m;
          } catch {
            // why: a server-sent event line that is not JSON-RPC is ignored; the next line may hold the answer
            /* a keep-alive or a partial line */
          }
        }
      } else if (body) {
        try {
          message = JSON.parse(body) as JsonRpcMessage;
        } catch {
          message = null;
        }
      }
      if (!message && !res.ok) message = { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: `HTTP ${res.status}` } };
      return { message, sessionId };
    },
  };
}
