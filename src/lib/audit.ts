/**
 * Lumen audit-log client. Fires `recordAudit(action, payload?)` from
 * mutation paths so the enterprise audit page (and any external SIEM
 * pipeline) can reconstruct who-did-what-when.
 *
 * Disabled when `VITE_AUDIT_ENDPOINT` is not set — keeps the cost
 * (network + storage) out of free-tier installs.
 *
 * Requests carry the signed-in user's own access token (Supabase JWT or
 * the SSO worker's token); the audit worker derives the user and their
 * scope from it. There is deliberately no shared audit secret in the
 * browser bundle — anyone could extract it and forge or read events.
 */

import { log } from "./logger";
import { fetchWithRetry } from "./fetchRetry";
import { useAuth } from "../auth/useAuth";
import { auditScope } from "../ui/auditScope";

/**
 * Scope an event is filed under when the caller doesn't pass one: the same
 * scope the audit-log UI reads (`auditScope`) — the SSO organization for
 * org members, else the user's own id — so every event shows up there.
 */
async function bearerFor(cfg: AuditConfig): Promise<string | null> {
  if (cfg.bearer !== undefined) return cfg.bearer || null;
  try {
    return (await useAuth.getState().provider.getAccessToken?.()) ?? null;
  } catch {
    return null;
  }
}

function defaultScope(userId: string): string {
  const user = useAuth.getState().user;
  return user && user.id === userId ? auditScope(user) : userId;
}

interface AuditConfig {
  endpoint: string;
  /** Test-only fixed bearer; production uses the auth provider's token. */
  bearer?: string;
}

let testOverride: AuditConfig | null = null;

/**
 * Test-only hook. Vite inlines `import.meta.env.VITE_*` at transform
 * time, so `vi.stubEnv` doesn't reach this module from a vitest test.
 * Tests call `__setAuditConfigForTesting({...})` instead, then `null`
 * to restore env-reading behaviour.
 */
export function __setAuditConfigForTesting(cfg: AuditConfig | null): void {
  testOverride = cfg;
}

/**
 * Read env on every call. Caching the values broke unit tests that
 * stub env between cases — re-reading is two property accesses,
 * negligible compared to the eventual fetch.
 */
function readConfig(): AuditConfig {
  if (testOverride) return testOverride;
  try {
    return { endpoint: (import.meta.env.VITE_AUDIT_ENDPOINT as string | undefined) ?? "" };
  } catch {
    return { endpoint: "" };
  }
}

export interface AuditRow {
  user_id: string;
  org_id?: string | null;
  action: string;
  payload_json?: string;
  ts?: number;
}

/**
 * Append an audit row. `userId` is the only required arg in practice;
 * everything else is optional metadata. The call is fire-and-forget —
 * a network failure logs but never throws into the calling path.
 */
export function recordAudit(
  userId: string,
  action: string,
  opts: { orgId?: string | null; payload?: unknown } = {},
): void {
  const cfg = readConfig();
  const { endpoint } = cfg;
  if (!endpoint) return; // audit disabled; no-op

  // user_id / org_id are informational: the worker records the identity
  // and scope it derives from the bearer token.
  const body: AuditRow = {
    user_id: userId,
    org_id: opts.orgId !== undefined ? opts.orgId : defaultScope(userId),
    action,
    payload_json: opts.payload === undefined ? undefined : JSON.stringify(opts.payload),
    ts: Date.now(),
  };

  void (async () => {
    const bearer = await bearerFor(cfg);
    if (!bearer) return; // not signed in — nothing the worker could attribute
    // Use fetch with keepalive so the row survives an unload race.
    await fetchWithRetry(`${endpoint.replace(/\/+$/, "")}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      keepalive: true,
    }, { label: "audit.record", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 2500 });
  })().catch((err) => {
    log.warn("audit submit failed", err);
  });
}

/** Read recent audit rows for an org (admin UI). */
export async function listAudit(opts: {
  orgId: string;
  limit?: number;
  before?: number;
  action?: string;
}): Promise<AuditRow[]> {
  const cfg = readConfig();
  const { endpoint } = cfg;
  if (!endpoint) return [];
  const bearer = await bearerFor(cfg);
  if (!bearer) throw new Error("Sign in to view the audit log");
  const params = new URLSearchParams({ orgId: opts.orgId });
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", String(opts.before));
  if (opts.action) params.set("action", opts.action);
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
  const res = await fetchWithRetry(
    `${endpoint.replace(/\/+$/, "")}/audit?${params.toString()}`,
    { headers },
    { label: "audit.list", maxRetries: 2, baseDelayMs: 800, maxDelayMs: 3000 },
  );
  if (!res.ok) throw new Error(`audit list failed: ${res.status}`);
  const json = (await res.json()) as { rows: AuditRow[] };
  return json.rows;
}
