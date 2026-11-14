/**
 * Entitlement store — reads the user's plan from the configured backend and
 * exposes a tiny `useCapabilities()` selector that feature code uses to gate
 * Pro-only paths.
 *
 * Today: localStorage shim for development (`lumen.dev.tier` ∈ free/pro/team).
 * Production wiring lives in `loadFromSupabase()` — flip the import when ready.
 *
 * Usage:
 *   const caps = useCapabilities();
 *   if (!caps.smartSearch) showUpgradePrompt();
 */

import { create } from "zustand";
import { capabilitiesFor, type Capabilities, type Entitlement, FREE_CAPS } from "./types";
import { log } from "../lib/logger";
import { useAuth } from "../auth/useAuth";
import { fetchWithRetry } from "../lib/fetchRetry";
import { publicEnv } from "../lib/publicEnv";

interface EntitlementStore {
  entitlement: Entitlement | null;
  capabilities: Capabilities;
  loading: boolean;
  /**
   * The last refresh failed (network / backend error). The capabilities are
   * then FREE_CAPS as a safe default, but the user's real plan is unknown —
   * callers that would *destroy* paid state (clear a saved server URL,
   * skip persistence) must not treat this as a downgrade.
   */
  failed: boolean;
  refresh: () => Promise<void>;
  /** Dev/QA helper — set the local tier without round-tripping the backend. */
  setLocal: (tier: Entitlement["tier"]) => void;
}

const DEV_KEY = "lumen.dev.tier";

type EnvShape = {
  VITE_ENTITLEMENT_ENDPOINT?: string;
};

let endpointOverride: string | null = null;

/**
 * Vite inlines `import.meta.env.VITE_*` at transform time, so `vi.stubEnv`
 * can't reach this module. Tests set the endpoint here instead (null resets).
 */
export function __setEntitlementEndpointForTesting(url: string | null): void {
  endpointOverride = url;
}

function readEnvVar(key: keyof EnvShape): string {
  if (key === "VITE_ENTITLEMENT_ENDPOINT" && endpointOverride !== null) return endpointOverride;
  return publicEnv(key);
}

function normalizeStatus(value: unknown): value is Entitlement["status"] {
  return value === "active" || value === "past_due" || value === "canceled" || value === "trialing" || value === "none";
}

function normalizeTier(value: unknown): value is Entitlement["tier"] {
  return value === "free" || value === "pro" || value === "team";
}

function isPlaceholder(value: string): boolean {
  const needle = value.toLowerCase();
  return (
    !value ||
    needle.includes("placeholder") ||
    needle.includes("example") ||
    needle.includes("change-me") ||
    needle.includes("todo")
  );
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value, location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toEntitlement(payload: unknown): Entitlement | null {
  if (!payload || typeof payload !== "object") return null;
  const src = payload as Record<string, unknown>;
  if (!normalizeTier(src.tier)) return null;
  if (!normalizeStatus(src.status)) return null;
  const ent: Entitlement = {
    tier: src.tier,
    status: src.status,
  };
  if (typeof src.renewsAt === "number") ent.renewsAt = src.renewsAt;
  if (typeof src.subscriptionId === "string") ent.subscriptionId = src.subscriptionId;
  return ent;
}

/**
 * True when a real billing backend is configured. Self-hosted / dev builds
 * leave VITE_ENTITLEMENT_ENDPOINT empty — feature gates treat that as
 * "everything unlocked" (see `billing/gates.ts`).
 */
export function isBillingConfigured(): boolean {
  const endpoint = readEnvVar("VITE_ENTITLEMENT_ENDPOINT");
  return !!endpoint && !isPlaceholder(endpoint) && isValidUrl(endpoint);
}

/** True when the dev/QA tier shim (`lumen.dev.tier`) is set. */
export function hasDevTierOverride(): boolean {
  return readDevTier() !== null;
}

async function accessToken(): Promise<string | null> {
  try {
    return (await useAuth.getState().provider.getAccessToken?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * GET VITE_ENTITLEMENT_ENDPOINT (the billing worker's `/entitlements`).
 * Sends the auth provider's access token as a bearer token when one is
 * available; the worker answers `{ entitlement: { tier, status, … } }`
 * and treats anonymous callers as free.
 */
async function fetchEntitlementFromBackend(): Promise<Entitlement | null> {
  if (!isBillingConfigured()) return null;
  const endpoint = readEnvVar("VITE_ENTITLEMENT_ENDPOINT");
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = await accessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchWithRetry(
    endpoint,
    {
      method: "GET",
      credentials: "include",
      headers,
    },
    { label: "entitlement.refresh" },
  );
  if (!res.ok) {
    throw new Error(`Could not fetch entitlement status (${res.status}).`);
  }
  const payload = (await res.json()) as { entitlement?: unknown } | Entitlement | null;
  const candidate =
    payload && typeof payload === "object" && "entitlement" in payload
      ? (payload as { entitlement: unknown }).entitlement
      : payload;
  return toEntitlement(candidate);
}

function readDevTier(): Entitlement | null {
  try {
    const raw = localStorage.getItem(DEV_KEY);
    if (!raw) return null;
    if (raw === "free" || raw === "pro" || raw === "team") {
      return { tier: raw, status: "active" };
    }
  } catch {
    /* storage may be denied */
  }
  return null;
}

/** Bumped by every refresh; a slower, older refresh never overwrites a newer one. */
let refreshSeq = 0;

export const useEntitlement = create<EntitlementStore>((set) => ({
  entitlement: null,
  capabilities: FREE_CAPS,
  loading: true,
  failed: false,
  async refresh() {
    const seq = ++refreshSeq;
    const apply = (patch: Partial<EntitlementStore>) => {
      if (seq === refreshSeq) set(patch);
    };
    set({ loading: true });
    try {
      // Prefer the dev shim while we wait for the real backend.
      const dev = readDevTier();
      if (dev) {
        apply({ entitlement: dev, capabilities: capabilitiesFor(dev), loading: false, failed: false });
        return;
      }
      const user = useAuth.getState().user;
      const ent = user ? await fetchEntitlementFromBackend() : null;
      if (ent) {
        apply({ entitlement: ent, capabilities: capabilitiesFor(ent), loading: false, failed: false });
        return;
      }
      apply({ entitlement: null, capabilities: FREE_CAPS, loading: false, failed: false });
    } catch (err) {
      log.warn("entitlement refresh failed", err);
      apply({ entitlement: null, capabilities: FREE_CAPS, loading: false, failed: true });
    }
  },
  setLocal(tier) {
    try {
      localStorage.setItem(DEV_KEY, tier);
    } catch {
      /* */
    }
    const ent: Entitlement = { tier, status: "active" };
    set({ entitlement: ent, capabilities: capabilitiesFor(ent), loading: false, failed: false });
  },
}));

export function useCapabilities(): Capabilities {
  return useEntitlement((s) => s.capabilities);
}

/**
 * Keep the entitlement in step with the signed-in identity: refresh whenever
 * the user (or the auth provider that vouches for them) changes — sign-in,
 * sign-out, or the initial session restore finishing after the app mounted.
 * Returns the unsubscribe function.
 */
export function watchAuthForEntitlements(): () => void {
  const key = (s: ReturnType<typeof useAuth.getState>) =>
    s.status === "loading" ? "loading" : `${s.provider?.name ?? ""}:${s.user?.id ?? ""}`;
  let last = key(useAuth.getState());
  return useAuth.subscribe((state) => {
    const next = key(state);
    if (next === last) return;
    last = next;
    if (next !== "loading") void useEntitlement.getState().refresh();
  });
}
