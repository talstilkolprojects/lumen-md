/**
 * What the sync UI says for the errors of a key change or a pairing that
 * the user must act on (third review 12.11): in the user's language, never
 * the engine's English message.
 */

import { t } from "../../../i18n";
import { PairingPendingError } from "../engine";
import { KeyringCommitLostError, KeyringForkError, TamperedWrapError } from "../keyring";
import { PairingEpochError } from "../pairing";
import "../strings";

/**
 * `side`: "answer" when this device checked another's pairing request,
 * "pair" when it entered a code or answer. `fallback` words any other error.
 */
export function e2eeErrorText(e: unknown, side: "answer" | "pair" | "other" = "other", fallback: (e: unknown) => string = (x) => String((x as Error)?.message ?? x)): string {
  if (e instanceof KeyringCommitLostError) return t("e2ee.rekey.unconfirmed");
  if (e instanceof KeyringForkError && e.revocationReapplied.length) return t("e2ee.fork.reapplied");
  if (e instanceof TamperedWrapError) return t("e2ee.wrap.tampered");
  if (e instanceof PairingPendingError) return t("e2ee.pair.pending");
  if (e instanceof PairingEpochError) {
    if (side === "answer" && e.kind === "older") return t("e2ee.pair.stale");
    if (side === "pair" && e.kind === "newer") return t("e2ee.fresh.olderKeys");
  }
  return fallback(e);
}
