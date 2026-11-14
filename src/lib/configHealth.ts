/**
 * Runtime dependency + feature health snapshot for startup diagnostics.
 *
 * No fake data, no randomness: this module uses only deterministic signals
 * (env vars, auth/entitlement state, and runtime capabilities).
 */

import type { AuthStatus } from "../auth/types";
import type { Entitlement } from "../billing/types";
import { publicEnv, type PublicEnvName } from "./publicEnv";

type HealthState = "ready" | "partial" | "blocked";

interface HealthWeightEntry {
  item: ConfigHealthItem;
  weight: number;
}

export interface ConfigHealthItem {
  key: string;
  label: string;
  status: HealthState;
  details: string;
}

export interface ConfigHealthContext {
  authStatus: AuthStatus;
  authProviderName?: string;
  authError?: string;
  userId?: string | null;
  entitlementLoading: boolean;
  entitlement: Entitlement | null;
  capabilitiesCloudSync?: boolean;
  aiKey: string | null;
  useLocalAi: boolean;
  hasWebGPU: boolean;
}

export interface ConfigHealthReport {
  score: number;
  maxScore: number;
  items: ConfigHealthItem[];
  blocked: ConfigHealthItem[];
  partial: ConfigHealthItem[];
}

function priceIdFromEnv(tier: "pro" | "team"): string {
  return readEnvVar(tier === "pro" ? "VITE_PRICE_ID_PRO" : "VITE_PRICE_ID_TEAM");
}

/** One name at a time (see lib/publicEnv): a whole-object read inlines every VITE_* value. */
function readEnvVar(key: PublicEnvName): string {
  return publicEnv(key);
}

function hasWritableLocalStorage(): boolean {
  try {
    const key = "lumen-config-health";
    localStorage.setItem(key, "1");
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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

function addHealth(
  items: HealthWeightEntry[],
  key: string,
  label: string,
  status: HealthState,
  details: string,
  weight: number,
): void {
  items.push({
    item: { key, label, status, details },
    weight,
  });
}

function weightedScore(items: HealthWeightEntry[]): number {
  const stateWeight: Record<HealthState, number> = {
    ready: 1,
    partial: 0.55,
    blocked: 0,
  };
  const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
  if (totalWeight <= 0) return 100;
  const currentWeight = items.reduce(
    (sum, i) => sum + i.weight * stateWeight[i.item.status],
    0,
  );
  return Math.round((currentWeight / totalWeight) * 100);
}

export function assessConfigHealth(ctx: ConfigHealthContext): ConfigHealthReport {
  const items: HealthWeightEntry[] = [];

  addHealth(
    items,
    "storage",
    "Storage",
    hasWritableLocalStorage() ? "ready" : "blocked",
    hasWritableLocalStorage()
      ? "LocalStorage/Session are writable."
      : "LocalStorage is unavailable (private mode or restricted browser).",
    2,
  );

  const authProvider = ctx.authProviderName?.toLowerCase() ?? "local";
  if (ctx.authStatus === "error") {
    addHealth(
      items,
      "auth",
      "Auth",
      "blocked",
      ctx.authError ?? "Auth bootstrap failed.",
      2,
    );
  } else if (authProvider === "local") {
    addHealth(
      items,
      "auth",
      "Auth",
      "partial",
      "Cloud auth is not configured. Running in local-only mode.",
      2,
    );
  } else if (ctx.authStatus === "loading") {
    addHealth(
      items,
      "auth",
      "Auth",
      "partial",
      "Auth state is loading.",
      1,
    );
  } else if (ctx.authStatus === "anonymous") {
    addHealth(
      items,
      "auth",
      "Auth",
      "partial",
      "Signed out. Some cloud features are limited.",
      1,
    );
  } else {
    addHealth(
      items,
      "auth",
      "Auth",
      "ready",
      `Authenticated as ${ctx.userId ?? "cloud user"}.`,
      1.5,
    );
  }

  if (ctx.entitlementLoading) {
    addHealth(
      items,
      "entitlement",
      "Entitlements",
      "partial",
      "Feature entitlements are still loading.",
      1.5,
    );
  } else if (!ctx.entitlement) {
    addHealth(
      items,
      "entitlement",
      "Entitlements",
      "partial",
      "No entitlement found; premium features default to Free.",
      1,
    );
  } else if (ctx.entitlement.status !== "active" && ctx.entitlement.status !== "trialing") {
    addHealth(
      items,
      "entitlement",
      "Entitlements",
      "partial",
      `Entitlement status: ${ctx.entitlement.status}. Some premium flows blocked.`,
      1,
    );
  } else {
    const tier = ctx.entitlement.tier;
    addHealth(
      items,
      "entitlement",
      "Entitlements",
      "ready",
      `Active entitlement: ${tier}.`,
      1,
    );
  }

  const billingEndpoint = readEnvVar("VITE_BILLING_ENDPOINT");
  if (!billingEndpoint) {
    addHealth(
      items,
      "billing",
      "Billing",
      "blocked",
      "Set VITE_BILLING_ENDPOINT to enable checkout/portal.",
      2,
    );
  } else if (!isValidUrl(billingEndpoint)) {
    addHealth(
      items,
      "billing",
      "Billing",
      "blocked",
      "VITE_BILLING_ENDPOINT is not a valid http/https URL.",
      2,
    );
  } else if (isPlaceholder(priceIdFromEnv("pro")) || isPlaceholder(priceIdFromEnv("team"))) {
    addHealth(
      items,
      "billing",
      "Billing",
      "partial",
      "Stripe price IDs are not fully configured. Set VITE_PRICE_ID_PRO and VITE_PRICE_ID_TEAM.",
      1.5,
    );
  } else {
    addHealth(
      items,
      "billing",
      "Billing",
      "ready",
      "Billing endpoint is configured.",
      2,
    );
  }

  const entitlementEndpoint = readEnvVar("VITE_ENTITLEMENT_ENDPOINT");
  if (ctx.authStatus === "authenticated") {
    if (!entitlementEndpoint) {
      addHealth(
        items,
        "entitlementEndpoint",
        "Entitlements",
        "partial",
        "Set VITE_ENTITLEMENT_ENDPOINT to sync plan status for the signed-in user.",
        0.8,
      );
    } else if (isPlaceholder(entitlementEndpoint) || !isValidUrl(entitlementEndpoint)) {
      addHealth(
        items,
        "entitlementEndpoint",
        "Entitlements",
        "partial",
        "VITE_ENTITLEMENT_ENDPOINT is malformed or placeholder-like.",
        0.8,
      );
    } else {
      addHealth(
        items,
        "entitlementEndpoint",
        "Entitlements",
        "ready",
        "Entitlement endpoint is configured.",
        0.8,
      );
    }
  }

  const publishEndpoint = readEnvVar("VITE_PUBLISH_ENDPOINT");
  if (!publishEndpoint) {
    const mockPublish = isPublishMockEnabled();
    addHealth(
      items,
      "publish",
      "Publish",
      mockPublish ? "partial" : "blocked",
      mockPublish
        ? "No publish endpoint configured. Mock publish is active in development."
        : "Set VITE_PUBLISH_ENDPOINT to enable read-mode publishing.",
      2,
    );
  } else if (!isValidUrl(publishEndpoint)) {
    addHealth(
      items,
      "publish",
      "Publish",
      "blocked",
      "VITE_PUBLISH_ENDPOINT is not a valid http/https URL.",
      2,
    );
  } else if (!ctx.capabilitiesCloudSync) {
    addHealth(
      items,
      "publish",
      "Publish",
      "partial",
      "Publish requires active Pro/Team entitlement.",
      1.5,
    );
  } else {
    addHealth(
      items,
      "publish",
      "Publish",
      "ready",
      "Publish endpoint is configured and entitlement allows cloud features.",
      1.5,
    );
  }

  const aiDetailsLocal = ctx.useLocalAi
    ? "Local AI mode is enabled."
    : "Cloud AI mode is enabled.";
  if (ctx.useLocalAi) {
    addHealth(
      items,
      "ai",
      "AI",
      ctx.hasWebGPU ? "ready" : "partial",
      ctx.hasWebGPU
        ? `${aiDetailsLocal} WebGPU available.`
        : `${aiDetailsLocal} WebGPU not available in this browser.`,
      1,
    );
  } else if (!ctx.aiKey) {
    addHealth(
      items,
      "ai",
      "AI",
      "partial",
      "Set AI key in settings to enable cloud AI requests.",
      1,
    );
  } else {
    addHealth(
      items,
      "ai",
      "AI",
      "ready",
      `${aiDetailsLocal} API key is configured.`,
      1,
    );
  }

  const webRtcOverride = readEnvVar("VITE_WEBRTC_SIGNALING_URL");
  if (webRtcOverride && !isValidUrl(webRtcOverride)) {
    addHealth(
      items,
      "collab",
      "Collab",
      "partial",
      "VITE_WEBRTC_SIGNALING_URL looks invalid; fallback servers may still work.",
      1,
    );
  } else {
    addHealth(
      items,
      "collab",
      "Collab",
      "ready",
      "Collab signaling is configured with fallback endpoints.",
      1,
    );
  }

  const dropboxAppKey = readEnvVar("VITE_DROPBOX_APP_KEY");
  const gdriveClientId = readEnvVar("VITE_GDRIVE_CLIENT_ID");
  if (!dropboxAppKey && !gdriveClientId) {
    addHealth(
      items,
      "cloudSync",
      "Cloud Sync",
      "partial",
      "No cloud provider configured (Dropbox/GDrive keys are missing).",
      0.8,
    );
  } else {
    const providerReady =
      (!dropboxAppKey || !isPlaceholder(dropboxAppKey)) &&
      (!gdriveClientId || !isPlaceholder(gdriveClientId));
    addHealth(
      items,
      "cloudSync",
      "Cloud Sync",
      providerReady ? "ready" : "partial",
      providerReady
        ? "At least one cloud provider key is configured."
        : "Cloud provider key looks like a placeholder.",
      0.8,
    );
  }

  const sentryDsn = readEnvVar("VITE_SENTRY_DSN");
  if (!sentryDsn) {
    addHealth(
      items,
      "telemetry",
      "Telemetry",
      "partial",
      "Telemetry disabled: VITE_SENTRY_DSN missing.",
      0.6,
    );
  } else if (!isValidUrl(sentryDsn)) {
    addHealth(
      items,
      "telemetry",
      "Telemetry",
      "partial",
      "Sentry DSN is present but malformed.",
      0.6,
    );
  } else {
    addHealth(
      items,
      "telemetry",
      "Telemetry",
      "ready",
      "Telemetry endpoint is configured.",
      0.6,
    );
  }

  const normalized = items.map((entry) => entry.item);
  const score = weightedScore(items);
  const blocked = normalized.filter((item) => item.status === "blocked");
  const partial = normalized.filter((item) => item.status === "partial");

  return {
    score,
    maxScore: 100,
    items: normalized,
    blocked,
    partial,
  };
}

function isPublishMockEnabled(): boolean {
  const explicit = readEnvVar("VITE_PUBLISH_MOCK_ENABLED");
  if (["1", "true", "yes"].includes(explicit?.toLowerCase())) return true;
  const viteDev = ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env)?.DEV;
  if (viteDev) return true;
  try {
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
  } catch {
    return false;
  }
}
