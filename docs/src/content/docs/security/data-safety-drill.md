---
title: Data-safety drill
description: Every way Lumen saves a note to a folder, driven through kill -9, a full disk, lost permissions and another program editing at the same time, with a report per release.
---

The drill checks the claim that a note is never half-saved. It drives
**each way Lumen writes a note to a folder** through four kinds of trouble,
on a real disk with real processes:

| Trouble | What happens |
|---|---|
| **kill -9** | A process saves notes as fast as it can and is killed with `SIGKILL` at a random moment, 1,000 times |
| **Full disk** | A note grows until a save no longer fits on a small file system (`ENOSPC`) |
| **Lost permission** | The folder and its notes become read-only in the middle of saving |
| **Another program** | An editor or a sync client saves the same notes (temporary file, then rename) while Lumen saves |

Each saved version carries a SHA-256 of its own text. After every round each
note must be **one whole version**, no older than before, and still there.
A save that fails must fail loudly, so the app keeps the text and tries
again.

The save paths it drives are the phone folder (`src/storage/vault/mobile.ts`,
the real code), the OPFS worker that Safari before 26 uses, the desktop app's
write in `src-tauri/vault/src/lib.rs` (its algorithm; `cargo test` checks the
Rust itself), and the atomic save of plan W1.5 when the checkout has it. The
browser's File System Access path is atomic by design and is covered by the
e2e matrix (`e2e/data-safety.spec.ts`).

## Run it

```sh
npm run drill:data-safety -- --kills 1000 --full-disk /mnt/small
```

`--full-disk` takes a small file system you mounted for the test (on Linux:
`sudo mount -t tmpfs -o size=256k tmpfs /mnt/small`); without it the full-disk
part is skipped. Run as root, the saving process drops to an unprivileged
user so the permission test means something.

The report goes to `reports/data-safety-drill-<commit>.md` and `.json`, one
per release. The exit code is 0 only when no note was damaged or lost.
