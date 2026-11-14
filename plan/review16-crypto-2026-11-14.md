# Crypto review 16 (14.11): lane K's K6 round (H1–H4), T5, and the SAS rebase

I'm an independent reviewer and wrote none of this. I worked read-only: no pushes, no comments, no merges.

There are two local-only side effects:
- The scratch test `src/__tests__/rr16-t5.attack.test.ts` sits in the `w-rr16-472` worktree. It was never committed, and a copy is at `rr16/`.
- A trial merge of #544 onto `dd6d757786` in `w-rr16-merge` (aborted afterwards) recorded rerere preimages in the local repository's `.git/rr-cache`. No resolutions were recorded and nothing was pushed.

**Heads** (checked with `gh api`):

| PR | Head | Worktree |
|---|---|---|
| #399 | `dd6d757786caf0c68168288ad4e0f730285a85f6` (fix 6e739abfcd) | `/home/claude/w-rr16-399` |
| #291 | `75ee8e5d95254cc90935d8220046f21bb7c1d00f` | `/home/claude/w-rr16-291` |
| #472 | `e92c7a1f258548511363fcbb1436d46f49e5d9d5` (T5 = f6ee847d66) | `/home/claude/w-rr16-472` |

- `S=/tmp/claude-0/-home-claude/db859785-2ec7-51e3-b6ba-0edfee54cc7b/scratchpad`.
- To run the e2ee tests: `$S/rr16/run.sh <worktree> <test>` (Node 22 with the `E/vt3` shim). `$S/rr16/all.sh` runs everything, and the logs are in `$S/rr16/runs/`.
- To run T5: `node $S/rr9/bh/run.mjs /home/claude/w-rr16-472 src/__tests__/rr16-t5.attack.test.ts` (Chromium).
- **A FAIL means the attack worked.**

## Verdict

| PR | Verdict | Open findings |
|---|---|---|
| #399 | **approve** | K6-1, K6-2, K6-3 low · K6-4, S-K6 info |
| #291 | **approve** | the same, through the merge |
| #472 | **approve** | the same, plus T5-1 low |

No critical or high finding is open. H1 is fixed, and H2, H3 and T5 are fixed for what they named, each with a low residue below. The conditions from review 9 still apply: no re-key, revoke or enroll UI until K6-1 and K6-3 are fixed, RR-10, and I5.

## H1: the epoch-bound refusal and the freeze-timer deletion — FIXED

- `rekeyBlocked` is now `{since, epoch}`. It is ignored at any other epoch, and dropped in `adopt` and `refresh` (`dropStaleEpochRecords`). A record without an epoch, from an earlier build, is void.
- A round deletes `frozenSeen` after a successful call-off, and whenever the manifest is not a live freeze (unfrozen, or listed in `aborted`).
- rr9-1 (a) and both (b) cases now pass. rr7-1 (2/2) and r5-7 (3/3) still pass, so G1's lockout fix and t8 both hold.
- The cost I predicted in review 9 does apply: binding to the epoch reopens a slow lever. A phone that *commits* real re-keys resets the wait each time. That's moot given H2, and every such commit is visible.

## H2: RevocationContestedError — sound for the real attacker, misattributed otherwise (K6-2, LOW)

- **Against the real attacker:** rr9-1 (c) now ends in `RevocationContestedError` from the second try. That is the intended, documented, inherent outcome, and the docs now lead with "change the storage password first".
- **K6-2, the misattribution:** `countContestedRevocation` (`engine.ts:930`) counts **any** compare-and-swap loss while the live keyring is still at the same epoch. It doesn't check that the keyring was actually rewritten by someone holding the epoch's keys.
  - `rr16-2 (a)`: a provider with no keys answers 412 twice. Result: `PreconditionFailedError | RevocationContestedError | RevocationContestedError`.
  - `rr16-2 (b)`: the provider serves the previous keyring revision. Result: `… | RevocationContestedError`.
  - In both cases the user reads that "something that still has the vault's keys … most likely the device you're removing" is blocking it.
- **Can an attacker use it to scare users or deny service?**
  - Scare: yes, a little. The advice it gives (rotate the storage login) is harmless; what's wrong is who it blames.
  - Denial of service: nothing new. The error is raised only after the write has already failed, and a provider can always refuse writes.
- **Fix:** count a loss only when the live keyring opens under this epoch's secret, has a higher revision than the one this device re-keyed from, and differs from it. Otherwise report a plain storage error.

## H3: the device lock across tabs — FIXED for what it covers, with two residues

**What holds:**
- rr9-3 (c) passes: the second tab is refused with `PairingDuringKeyChangeError`.
- No deadlock: tab 2's key change waits while tab 1 holds the lock, then completes (`rr16-3 (c)`, epoch 3). There is a single lock name per device and vault, so there is no lock ordering to get wrong.
- Re-entry within an engine (`lockHeld`) is safe, because every public call runs under `exclusive`.
- Taking up another tab's keys (`reloadState`) goes through `refreshKeys` (same-epoch lineage, the descent of newer epochs, rollback refusal) and then `verifyAnchor` on the stored anchor. That's the same path as a normal refresh, and I found no way around it.
- **Starvation (K6-4, info):** Web Locks queue first in, first out, and pairing uses `ifAvailable`, so pairing is refused rather than starved. However, a provider call that never returns holds the lock until the tab closes. Without `navigator.locks` the fallback works within one page only, which is documented.

**K6-1 — LOW — lost updates across tabs remain.**
- Rounds take no lock and don't re-read the state. So a tab with an older cached `DeviceState` saves it over a newer one.
- `rr16-3 (a)`: tab 1 revokes the phone, then tab 2's ordinary round runs. Afterwards `revokedHere` is `null` and `rekeyed` is `false`. `sealedRevoked` still lists the phone (G5), so a plain readmission is still caught.
- But losing `rekeyed` disables `reapplyRevocation`, which is the N2/F2 repair after a provider lies about a compare-and-swap.
- The same mechanism can overwrite `pairingUntil` (the N3 hold) and `freshness`.
- **Fix:** run rounds under the device lock with `reloadState` too, or make `save()` merge with the stored state (the maximum of anchors and epochs, the union of `revokedHere` and `sealedRevoked`, and keep `rekeyed` and `pairingUntil`).

**K6-3 — LOW — the lock name uses the cached device id.**
- The name is built at `engine.ts:852-853`, from the device id read before `reloadState`.
- Two tabs of a device that started before anything was stored each generate their own device id. They then take different locks, so the exclusion fails.
- `rr16-3 (b)`: the ids differ, and tab 2 makes a code (`lumen-pair:3:1`, epoch 1) during tab 1's stalled revocation. The stored device id also flips between the two tabs' ids.
- **Fix:** name the lock by vault only, or take the device id from the store.

## T5: lock forgets every vault's keys — FIXED; auto-lock has a gap (T5-1, LOW)

- `lock()` now clears every unlocked session. The control `rr16-t5 (b)` passes, the PR's case passes, and `vaultEncryption` gives 29/29 in Chromium.
- **T5-1:**
  - Turning encryption off on vault B calls `stopAutoLock()` (`session.ts:380`) even while vault A's session still holds keys.
  - `rr16-t5 (a)`: auto-lock intervals go 1 → 0. An explicit idle check would lock A, but nothing runs one any more, so A stays unlocked until the user locks it by hand.
  - **Fix:** stop the timer only when `unlockedSessions` is empty.
- **Minor:** `lock()` while a plain vault is current (but another encrypted vault was unlocked) sets the state to "locked" and brings up the unlock screen over the plain vault. This is UI only.

## SAS (#544) and K6 together

A trial merge of `b0677b2cde` onto `dd6d757786` (aborted afterwards):
- **Textual conflicts only.** In `engine.ts`, the new error classes and the new fields sit side by side. The rest are i18n files and `errorText.ts`.
- **What merges cleanly:**
  - `pairingCode` and `answerPairing` merge into `pairingUnderLock`.
  - SAS's `prevUntil` is then read from the re-read state, which is correct.
  - `liveIssuing` still ends an issuing session when `reloadState` adopts another tab's newer keys. That fails safe.
- **What to fix on the rebase:** `confirmPairing`, `rejectPairing` and `cancelPairing` run without the lock or a reload. So K6-1 also reaches the hold they restore and the joiner's commit. Take the device lock in those three.
- **Re-run after the rebase:** rr13 (S13-1 is still open), rr16-3 and rr9-3.

## Suites (plain Node with the shim)

| Suite | #399 | #291 | #472 |
|---|---|---|---|
| e2eeNinthReview · e2eeSeventhReview · e2eeFifthReview · e2eeThirdReview · e2eeRekeyIntegrity | 7/7 · 9/9 · 16/16 · 10/10 · 15/15 | same (FifthReview 16/16 rerun alone¹) | same |
| e2eeKeyring | 5/6 (10,000-note case times out, as on every head) | hit the 1000 s limit | 5/6 |
| e2eeSync · e2eeVectors · e2eeCrypto · e2eeAge · e2eeRandom | 40/43 (ConflictDialog DOM) · 5/5 · 12/12 · 5/5 · 1/1 | same | same |
| syncProviders · syncMigration | — | 25/30 (DOMParser) · 9/9 | 17/22 (DOMParser) · 9/9 |
| `check_vectors.py` | 31/31 | 31/31 | 31/31 |
| rr9-1 · rr9-2 · rr9-3 · rr9-4 | 3/4 ((c) expected) · 1/2 (H4, message only) · 3/3 · 3/3 | same (rr9-1 3/4 rerun alone¹) | same |
| rr7 r7-1 · r7-2 · r7-3 · r7-4 · r7-5 · r5-7 | 2/2 · 1/1 · 2/2 · 1/2 (G4) · 3/3 · 3/3 | same | same |
| `.k4` copies r5-1 · r5-2 · r5-4 | 5/5 · 2/2 · 3/3 | same | same |
| rr16-2 · rr16-3 | 1/3 · 1/3 | same | same |
| rr16-t5 (Chromium) · vaultEncryption | — | — | 1/2 · 29/29 |

¹ **Timeouts, not failures.** The full run shared the machine with other sessions. In it, #291 gave e2eeFifthReview 15/16 (F5's production-parameter Argon2id case) and rr9-1 2/4 ((a) timed out, though its printout showed the secure outcome). Rerun alone, they give 16/16 and 3/4 (`runs/rerun-291.out`). The intermittent failure I noted in review 13 is very likely this same Argon2id timeout.

## Receipts

`$S/rr16/receipts/{399,291,472}.json` (`lumen-review` v1), written by `$S/rr16/mkreceipts.mjs`. I checked each with `receiptProblems` and `receiptFor` from `w-rr9-rr` against the PR's current file list:

| PR | Verdict | Check result |
|---|---|---|
| #399 | approve | no problems |
| #291 | approve | no problems |
| #472 | approve | no problems |
