/**
 * Stripe checkout launcher.
 *
 * The browser never sees a Stripe secret key — we POST to a server endpoint
 * that creates a Checkout Session and returns its URL, then redirect.
 *
 * The endpoint is a tiny Edge function (Cloudflare Worker / Vercel /
 * Supabase Edge Function) that:
 *   1. Reads the bearer token (from `Authorization: Bearer <jwt>`).
 *   2. Verifies the user is who they say they are.
 *   3. Calls `stripe.checkout.sessions.create({ ... })` with the price id.
 *   4. Returns `{ url }`.
 *
 * Wire it via `VITE_BILLING_ENDPOINT=https://your-edge.example.com/checkout`.
 */

import type { PlanTier } from "./types";
import { fetchWithRetry } from "../lib/fetchRetry";
import { publicEnv } from "../lib/publicEnv";

type EnvShape = { VITE_BILLING_ENDPOINT?: string; VITE_PRICE_ID_PRO?: string; VITE_PRICE_ID_TEAM?: string };
// One name at a time (see lib/publicEnv): a whole-object read inlines every VITE_* value.
const env = (): EnvShape => ({
  VITE_BILLING_ENDPOINT: publicEnv("VITE_BILLING_ENDPOINT") || undefined,
  VITE_PRICE_ID_PRO: publicEnv("VITE_PRICE_ID_PRO") || undefined,
  VITE_PRICE_ID_TEAM: publicEnv("VITE_PRICE_ID_TEAM") || undefined,
});

function endpoint(): string {
  const value = env().VITE_BILLING_ENDPOINT;
  if (!value) throw new Error("VITE_BILLING_ENDPOINT is not set — billing offline.");
  return value;
}

function resolvePriceId(tier: Exclude<PlanTier, "free">): string {
  const configured = (
    tier === "pro"
      ? env().VITE_PRICE_ID_PRO
      : env().VITE_PRICE_ID_TEAM
  )?.trim();
  if (!configured) {
    throw new Error(`VITE_PRICE_ID_${tier.toUpperCase()} is not set.`);
  }
  return configured;
}

function isConfiguredPriceId(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    !normalized.includes("placeholder") &&
    !normalized.includes("TODO") &&
    !normalized.includes("example")
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

function portalEndpoint(): string {
  const base = endpoint();
  if (!isValidUrl(base)) {
    return `${base.replace(/\/+$/, "")}/portal`;
  }
  const url = new URL(base, location.origin);
  const trimmed = url.pathname.replace(/\/checkout\/?$/, "");
  const stem = trimmed.replace(/\/+$/, "");
  url.pathname = stem === "" || stem === "/" ? "/portal" : `${stem}/portal`;
  return url.toString();
}

export async function startCheckout(tier: Exclude<PlanTier, "free">, jwt: string | null): Promise<void> {
  if (!jwt) throw new Error("Sign in first to subscribe.");
  // Validate the billing endpoint first — it's more fundamental than
  // any price ID. If billing isn't configured at all we want the user
  // to see that error, not a per-tier price-id error.
  const checkoutUrl = endpoint();
  const priceId = resolvePriceId(tier);
  if (!isConfiguredPriceId(priceId)) {
    throw new Error(`VITE_PRICE_ID_${tier.toUpperCase()} is not configured for ${tier}.`);
  }
  const res = await fetchWithRetry(
    checkoutUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        priceId,
        successUrl: `${location.origin}/billing/success`,
        cancelUrl: `${location.origin}/billing/cancel`,
      }),
    },
    {
      label: "billing.checkout",
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Checkout failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const { url } = (await res.json()) as { url: string };
  location.assign(url);
}

/**
 * Open the Stripe billing portal. By default the worker picks the
 * organization's Team plan the caller bought, else their personal plan;
 * `scope: "personal"` always opens the personal one (for someone who has
 * both).
 */
export async function openBillingPortal(
  jwt: string | null,
  opts: { scope?: "personal" } = {},
): Promise<void> {
  if (!jwt) throw new Error("Sign in first to manage billing.");
  const res = await fetchWithRetry(
    portalEndpoint(),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(opts.scope ? { scope: opts.scope } : {}),
    },
    {
      label: "billing.portal",
    },
  );
  if (!res.ok) throw new Error(`Portal failed (${res.status})`);
  const { url } = (await res.json()) as { url: string };
  location.assign(url);
}
