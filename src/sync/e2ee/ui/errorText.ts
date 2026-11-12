/**
 * What the sync UI says for the errors of a key change or a pairing that
 * the user must act on (third and fifth reviews 12.11): in the user's
 * language, never the engine's English message.
 */

import { t } from "../../../i18n";
import { DropDevicesRequiredError, KeyChangeInProgressError, PairingDuringKeyChangeError, PairingPendingError } from "../engine";
import { DroppedFromVaultError, KeyringCommitLostError, KeyringForkError, RevokedError, TamperedWrapError } from "../keyring";
import { PairingEpochError } from "../pairing";
import "../strings";

/**
 * `side`: "answer" when this device checked another's pairing request,
 * "pair" when it entered a code or answer. `fallback` words any other error.
 */
export function e2eeErrorText(e: unknown, side: "answer" | "pair" | "other" = "other", fallback: (e: unknown) => string = (x) => String((x as Error)?.message ?? x)): string {
  if (e instanceof KeyringCommitLostError) return t("e2ee.rekey.unconfirmed");
  if (e instanceof KeyringForkError) {
    // Every fork in words (fifth review F2): repaired, a revocation at risk, or refused.
    if (e.revocationReapplied.length) return t("e2ee.fork.reapplied");
    if (e.revocationAtRisk.length) return t("e2ee.fork.atRisk");
    return t("e2ee.fork.refused");
  }
  if (e instanceof TamperedWrapError) return t("e2ee.wrap.tampered");
  if (e instanceof DroppedFromVaultError) return t("e2ee.dropped");
  if (e instanceof RevokedError) return t("e2ee.revoked");
  if (e instanceof DropDevicesRequiredError) return t("e2ee.rekey.dropConfirm", { devices: e.devices.join(", ") });
  if (e instanceof KeyChangeInProgressError) return t("e2ee.rekey.busy");
  if (e instanceof PairingPendingError) return t("e2ee.pair.pending");
  if (e instanceof PairingDuringKeyChangeError) return t("e2ee.pair.rekeying");
  if (e instanceof PairingEpochError) {
    if (side === "answer" && e.kind === "older") return t("e2ee.pair.stale");
    if (side === "pair" && e.kind === "newer") return t("e2ee.fresh.olderKeys");
  }
  return fallback(e);
}

/**
 * What a sync round's result asks the user to know beyond its counts
 * (seventh review 12.11, G5): i18n keys, in the user's language via `t`.
 */
export function e2eeResultNotices(r: { revokedListReset?: true }): string[] {
  return r.revokedListReset ? [t("e2ee.revokedHere.reset")] : [];
}
