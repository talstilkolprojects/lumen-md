/**
 * End-to-end encrypted sync (plan 3.4) — the core. Import it lazily
 * (`await import("./sync/e2ee")`): nothing here belongs in the startup bundle.
 *
 * Protocol, threat model and what the provider sees:
 * docs/src/content/docs/sync/e2ee.md.
 */

export { createVault, unlockVault, E2eeSync, DropDevicesRequiredError, KeyChangeInProgressError, NoVaultError, PairingDuringKeyChangeError, RevocationContestedError, UnverifiedDeviceError, VaultExistsError } from "./engine";
export type { E2eeSyncOptions, SyncResult } from "./engine";
export type { SyncProvider, StoredObject, PutCondition } from "./provider";
export { CasUnsupportedError, memoryProvider, PreconditionFailedError, proveCas, ProviderUnavailableError } from "./provider";
export { DroppedFromVaultError, KeyringForkError, KeyringRollbackError, PreReleaseKeyringError, RevokedError } from "./keyring";
export { vaultLocalFiles, memoryFiles, type LocalFiles } from "./localFiles";
export { idbStateStore, memoryStateStore, type DeviceState, type FreshnessSource, type SyncStateStore } from "./state";
export { dialogResolver, keepBothResolver, type ConflictResolver, type ConflictResolution } from "./conflict";
export { RollbackError } from "./manifest";
export { PairingEpochError, PairingError } from "./pairing";
export { WrongPassphraseError, UnsupportedProtocolError, PROTOCOL_VERSION } from "./header";
export { KdfUnavailableError, WeakKdfError, PBKDF2_MIN_ITERATIONS } from "./kdf";
export { DecryptError } from "./keys";
