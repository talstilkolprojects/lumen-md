/**
 * In-app routes to buy or manage a plan: the upgrade notices shown by gated
 * features and the palette's billing commands both go through these, so a
 * gate never leaves the user without a way to unlock it.
 */
import { useAuth } from "../auth/useAuth";
import { toast } from "../store/useToastStore";
import { t } from "../i18n";
import { isBillingConfigured, useEntitlement } from "./useEntitlement";
import type { PlanTier } from "./types";
import { explainError } from "../lib/userError";

async function accessToken(): Promise<string | null> {
  try {
    return (await useAuth.getState().provider.getAccessToken?.()) ?? null;
  } catch {
    return null;
  }
}

/** True when the user has a subscription record the billing portal can manage. */
export function hasManageableSubscription(): boolean {
  const ent = useEntitlement.getState().entitlement;
  return !!ent && ent.tier !== "free" && ent.status !== "none";
}

/** Plan purchase is possible in this build (billing configured). */
export function canPurchasePlans(): boolean {
  return isBillingConfigured();
}

/** Start Stripe Checkout for `tier`; asks the user to sign in when needed. */
export async function upgradeTo(tier: Exclude<PlanTier, "free">): Promise<void> {
  const jwt = await accessToken();
  if (!jwt) {
    toast.info(t("billing.action.signInFirst"));
    return;
  }
  try {
    const { startCheckout } = await import("./checkout");
    await startCheckout(tier, jwt);
  } catch (err) {
    toast.error(t("billing.action.failed"), explainError(err));
  }
}

/**
 * Open the Stripe billing portal for the signed-in user. `personal` opens
 * their own plan even when they also bought their organization's Team plan.
 */
export async function manageBilling(scope?: "personal"): Promise<void> {
  const jwt = await accessToken();
  if (!jwt) {
    toast.info(t("billing.action.signInFirst"));
    return;
  }
  try {
    const { openBillingPortal } = await import("./checkout");
    await openBillingPortal(jwt, scope ? { scope } : {});
  } catch (err) {
    toast.error(t("billing.action.failed"), explainError(err));
  }
}
