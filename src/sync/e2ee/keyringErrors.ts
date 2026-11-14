/**
 * The keyring's errors (split out of keyring.ts, W4.11; no behaviour
 * change). Import them from "./keyring".
 */

import { DecryptError } from "./keys";

export class RevokedDeviceEnrollError extends Error {
  constructor(public readonly device: string) {
    super(`The device "${device}" (or its key) was removed from the vault; enroll it again with a new id and a new key`);
    this.name = "RevokedDeviceEnrollError";
  }
}

export class RevokedError extends Error {
  constructor() {
    super("This device was removed from the vault: it can't open the current keys");
    this.name = "RevokedError";
  }
}

/**
 * This device was left out, not revoked (fifth review 12.11, F4): a device
 * that couldn't verify the device list re-keyed (with the user's consent,
 * `dropDevices`), so the new keys are wrapped for the passphrase and the
 * devices it enrolled only. Nothing on this device was changed: pair it
 * again from a device you trust (or unlock it with the passphrase).
 */
export class DroppedFromVaultError extends Error {
  constructor(public readonly epoch: number) {
    super("A device that couldn't verify the vault's device list changed the keys, and this device wasn't carried over (it wasn't removed). Nothing on this device was changed: pair it again from a device you trust, or unlock it with the passphrase.");
    this.name = "DroppedFromVaultError";
  }
}

/**
 * This device's wrap in the keyring doesn't open it (third review 12.11, N5):
 * the age file decrypts, or is there, but its secret doesn't open the
 * keyring's sealed part. The storage changed the wrap (or put back one from
 * another epoch); whether this device is still enrolled can't be told from
 * it. Nothing is changed on the device: try again later, or pair it again.
 * Unlike `RevokedError`, never a reason to act on the device's data.
 */
export class TamperedWrapError extends DecryptError {
  constructor() {
    super("This device's key in the vault's keyring doesn't open the keyring: the storage changed it, or put back an old one. Nothing on this device was changed. Try again later; if it stays like this, pair this device again from one you trust.");
    this.name = "TamperedWrapError";
  }
}

/**
 * A keyring this device just wrote is not what the storage returns right
 * after (third review 12.11, N2): the storage accepted a conditional write
 * it should have refused, and another device's key change replaced this
 * one. `revoked` lists the devices this write revoked: the revocation may
 * not have taken effect, and must be made again from a verified device.
 */
export class KeyringCommitLostError extends Error {
  constructor(
    public readonly revoked: string[],
    detail = "the storage returned another keyring right after this device wrote its own",
  ) {
    super(
      `${revoked.length ? `The revocation of ${revoked.map((d) => `"${d}"`).join(", ")} may not have taken effect: ` : "This device's key change did not take effect: "}${detail} (it ignored a conditional write). Sync, then make the change again from a verified device; if it happens again, don't trust this storage with key changes.`,
    );
    this.name = "KeyringCommitLostError";
  }
}

export class KeyringRollbackError extends Error {
  constructor(
    public readonly seen: number,
    public readonly got: number,
    message?: string,
  ) {
    super(message ?? `The provider returned keyring epoch ${got}, older than ${seen} seen before — refused (rollback)`);
    this.name = "KeyringRollbackError";
  }
}

/**
 * A keyring that doesn't descend from the one this device verified last
 * (RR-2). `revocationReapplied` (third review 12.11, N2): the keyring that
 * replaced this device's own re-key was another device's at the same epoch,
 * which didn't revoke these devices; this device revoked them again on top
 * of it, at epoch `reappliedAt`. Anything written in between may be
 * readable by them: the revocation may not have taken effect for it.
 */
export class KeyringForkError extends Error {
  constructor(
    public readonly detail: string,
    public readonly revocationReapplied: string[] = [],
    public readonly reappliedAt: number | null = null,
    /**
     * Devices this device revoked that the refused keyring may let back in
     * (fifth review 12.11, F2), when it couldn't revoke them again on top:
     * the UI says the revocation may have been undone.
     */
    public readonly revocationAtRisk: string[] = [],
  ) {
    super(
      revocationReapplied.length
        ? `The storage replaced this device's key change with another device's (${detail}): it ignored a conditional write. The revocation of ${revocationReapplied.map((d) => `"${d}"`).join(", ")} may not have taken effect for what was written in between; this device made it again at key epoch ${reappliedAt}. Sync every device, and don't trust this storage with key changes.`
        : `The provider returned a keyring that doesn't descend from the one this device verified (${detail}) — refused (fork).${revocationAtRisk.length ? ` The revocation of ${revocationAtRisk.map((d) => `"${d}"`).join(", ")} may have been undone.` : ""} Don't re-key or enroll until every device agrees; pair this device again from one you trust.`,
    );
    this.name = "KeyringForkError";
  }
}

/** A keyring from a pre-release build (no sealed device list): its device list can't be trusted (RR-1). */
export class PreReleaseKeyringError extends DecryptError {
  constructor() {
    super(
      "This vault's keyring was written by a pre-release build of Lumen, and its device list can't be trusted. Reset it from a device that has the passphrase (unlock with resetPreReleaseKeyring, then re-key): the new keys are wrapped for the passphrase only, and every device enrolls again.",
    );
    this.name = "PreReleaseKeyringError";
  }
}
