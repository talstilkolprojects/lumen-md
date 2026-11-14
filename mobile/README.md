# The vault in a folder on the phone — native part (plan 4.20)

The JavaScript side is `src/storage/vault/mobile.ts` (a `VaultBackend` over
a small `MobileFs` bridge) and the `mobile` location in
`src/storage/vault/location.ts`. It runs the VaultBackend contract suite
over fakes of both native APIs (`src/__tests__/vaultMobile.test.ts`). The
native part could not be built in the environment this was written in, so
it is kept to the minimum below. Device checks: owner item 15.13.

## iOS — the app's Documents folder, visible in the Files app

1. `npm install @capacitor/filesystem --package-lock-only && npm ci`
   (adds the official plugin; not in the lockfile yet), then `npx cap sync ios`.
2. `ios/App/App/Info.plist` already has `UIFileSharingEnabled` and
   `LSSupportsOpeningDocumentsInPlace` = true, so the folder shows in the
   Files app as *On My iPhone › Lumen*.

Nothing else: the vault is the Documents folder itself (`Directory.Documents`).

## Android — a folder the user picks (Storage Access Framework)

1. Same plugin for the fallback (the app's own folder, `Directory.External`):
   `npm install @capacitor/filesystem --package-lock-only && npm ci`, then
   `npx cap sync android`.
2. The plugin is in the app already (W10.C14):
   `android/app/src/main/java/com/lumen/editor/LumenVaultFolderPlugin.java`,
   registered in `MainActivity.java` before `super.onCreate`.

   It uses only framework APIs (`DocumentsContract`), no new Gradle
   dependency. `pickFolder` opens `ACTION_OPEN_DOCUMENT_TREE` and keeps the
   permission (`takePersistableUriPermission`); `hasAccess` tells the app at
   start whether it still has it (otherwise the vault shows as disconnected
   until the folder is picked again).

Without the plugin the app falls back to its own folder; without
`@capacitor/filesystem` choosing a phone folder says what is missing and
the vault stays where it is.

## What to check on a device (15.13)

- Move the vault to the phone folder (palette → *Move the vault to a folder…*): notes are copied, the app storage is kept.
- Edit a note in the Files app (iOS) or another editor (Android), come back to Lumen: the change shows (within ~3 s, at once on return to the app).
- Edit the same note in Lumen and outside at the same time: the conflict dialog, nothing lost (4.4).
- Android: revoke the folder permission in the system settings: Lumen shows the vault as disconnected, *Reconnect* asks for the folder again.
- Android: a new note is created without an extra extension (`note.md`, not `note.md.bin`).
