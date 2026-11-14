# Ninth crypto review 12.11 (round 6): lane K's round-5 fixes, and #529

I'm an independent reviewer and wrote none of this code. I worked read-only: I pushed nothing, commented nothing and merged nothing. The only file I added to a worktree is the scratch test `src/__tests__/rr9-529.attack.test.ts` in the local review worktree `w-rr9-529`. It was never committed, and a copy is in `rr9/`.

**Heads** (re-checked with `gh api` when the review resumed; #529 had not moved):

| PR | Branch | Head | Worktree |
|---|---|---|---|
| #399 | feat/sync-crypto | `ccceffea0e2a3311e968bd5dbadf95478709a76d` (fix 597d3140ce) | `/home/claude/w-rr9-399` |
| #291 | feat/e2ee-sync-providers | `a48aef25fcb489daf3f135cd564fcd60c7734766` | `/home/claude/w-rr9-291` |
| #472 | feat/vault-argon2id | `79195fe155136f3788f8221bc0fc296d087fb0e7` | `/home/claude/w-rr9-472` |
| #529 | perf/encrypted-snapshot (base verify/train-2) | `0d07aa216f85b41e2d928833b44538e75ca1dad5` | `/home/claude/w-rr9-529` |
| receipt format | feat/review-required | `d3190ee7ca` | `/home/claude/w-rr9-rr` |

`S=/tmp/claude-0/-home-claude/db859785-2ec7-51e3-b6ba-0edfee54cc7b/scratchpad`.

- The e2ee core files (`engine`, `keyring`, `pairing`, `keys`, `header`, `state`, `manifest`, `provider`, `kdf`) have the same blob ids on all three e2ee heads, so every e2ee result below holds for all three.
- **Run the e2ee tests:** `$S/rr9/run.sh <worktree> <test>`. That is plain Node 22 with `--experimental-transform-types` and the `E/vt3` shim. `$S/rr9/all.sh` runs everything, and the logs are in `$S/rr9/runs/`.
- **Run the #529 tests:** `node $S/rr9/bh/run.mjs /home/claude/w-rr9-529 src/__tests__/rr9-529.attack.test.ts`. The harness is a copy of `A13/bh`. `U/bh` stubs `idb-keyval`, so under it even the PR's own suite fails.
- **Reading results:** every rr9 test asserts the secure outcome, so **a FAIL means the attack worked.**

## Bottom line

| PR | Verdict | Open findings |
|---|---|---|
| #399 | **approve** (conditions below) | H1 medium · H2, H3 low · H4, H5 info |
| #291 | **approve** | same, through the merge; its own diff has no new crypto |
| #472 | **approve** | same, through the merge; the at-rest vault code is unchanged |
| #529 | **changes-requested** | **S1 high** · S3 low · S2, S4 info |

**Conditions for the three e2ee PRs:**
1. Fix H1 and the H2 doc line before any re-key, revoke or enroll UI ships. #291 still has none.
2. RR-10 stands: `chore/release-beta1` must be rebuilt from these heads.
3. The owed real-server runs (I5) are still needed.

**G1, G2, G3 and G5 are fixed for the attacks they named.** However, G1's fix gives up the t8 protection (H1), and the device being revoked still has another way to stall its revocation (H2).

## 1. G1: the bounded wait and the takeover

### Q1a: can the revoked device still delay a revocation or a passphrase change?

**Through the freeze: no.** rr7-1 passes 2/2: the attempts at 0 and 9 minutes are refused, and the one at 18 minutes revokes; the passphrase change then gives epoch 3. I checked each lever in the brief:

- **The saved first-refusal time** lives only in local state (`rekeyBlocked`). The phone and the provider can't write it, and nothing in a freeze (`digest`, `at`, `by`) feeds it (`engine.ts:814-824`).
- **The 24-hour reset.** It restarts the wait only when the user's retries are more than 24 hours apart. Even then the delay is one more 10 minutes, so it can't be turned into a lockout.
- **Rolling back local state.** A restored backup can only lose `rekeyBlocked`, and that costs at most 10 more minutes. The attacker can't do it.
- **Clock skew.** Only this device's clock is used. If it jumps back (`t > now`, `:815`), the wait restarts once. If it jumps forward, the wait gets shorter, which weakens t8 but not the attacker's position.
- **Breaking the run in `round()` with unfrozen manifests.** This can delay held uploads, but each unfrozen gap lets the round upload. It is not a lockout.

**By other means: yes. This is H2 (low, inherent).**
- `rr9-1 (c)`: the phone bumps the keyring's `rev` with a no-op `rewriteKeyring` whenever A writes. A's revocation gets `PreconditionFailedError` on every try, and the phone keeps its wrap.
- Any compare-and-swap writer that holds S_N and the storage login can do this (deleting objects works too).
- But `docs/src/content/docs/sync/e2ee-keys.md:109` now promises "try again after 10 minutes and the removal goes through". That is not true while the lost device keeps its storage login.
- **Fix:** change the docs to say "change the storage password or token for the lost device first". Optionally, retry the commit a few times when the keyring was rewritten at the same epoch.

### Q1b: is t8's protection kept? No. This is H1 (medium).

**(a) A stale refusal shortens a new wait.**
- `rekeyBlocked` has no epoch, and only this device's own commit clears it (`engine.ts:815`, `:965`).
- So a refusal from a key change that another device finished still counts for 24 hours.
- `rr9-1 (a)`: A is refused at t0 by B's in-flight re-key, and B commits. Three hours later B starts a new honest re-key, and A's re-key **freezes over it at once** (epoch 3; B gets `PreconditionFailedError`). The `rekeyBlocked` printed after B's commit is `{"since":1800000000000}`.

**(b) `frozenSeen` outlives a call-off.**
- `frozenSeen` survives a successful `callOffFreeze` when the round has nothing to upload. The called-off manifest stays frozen, so the deletion at `:1469` never runs, and the deletion at `:1549` needs a commit.
- `rr9-1 (b)`: 1 hour later, A's next round **calls off B's fresh honest freeze immediately** (`rekeyPending=false`, 2 aborted entries, B gets `PreconditionFailedError`).
- A's own re-key inherits this through `min(since, frozenSeen.at)` (`:823`) and freezes over B's freeze too.

**Impact:**
- With an honest compare-and-swap, the other device's re-key fails loudly, and it can fail again each time A's periodic round catches it mid-flight.
- Against t8's provider (If-Match dropped on the keyring), both re-keys commit. Only N2's read-back and F2's reapply then repair the fork, which is the very race Q2 was meant to prevent.
- The spec's claim (§5) that "an honest re-key commits within seconds, far inside the wait" doesn't hold in these windows.
- Lane K's t8 test only covers a refusal older than 24 hours, so it doesn't catch this.

**Fix:**
- Store `rekeyBlocked = {since, epoch}` and drop it when the epoch moves (the change that blocked it has committed).
- Delete `frozenSeen` after a successful `callOffFreeze`, or tie the run to the digest that was called off.
- Add `rr9-1 (a)` and `(b)` as regression tests.
- Binding to the epoch reopens a slower lever for a phone that really commits re-keys. H2 makes that moot, and the honest-device correctness matters more.

## 2. G2: the marker epoch check and removal on re-enrol

- **Fixed:** rr7-2 passes 1/1. Lane K's test checks that enrolling the device again removes its marker.
- **Removal on re-enrol (`keyring.ts:820-842`):**
  - A forged marker (bad MAC) is dropped.
  - A marker whose previous secret the enrolling device lacks is dropped entirely, which takes other devices' notices with it. That only changes a message.
- **H4 (info):**
  - Setup: a tablet is re-enrolled while offline, so it still holds only S1. It is then revoked, and the storage (the marker is outside the digest) puts M2 back.
  - Result: `M2.epoch = 1+1` passes the check, so the tablet reads `DroppedFromVaultError` instead of `RevokedError` (`rr9-2 (b)`).
  - Impact: the message only. Re-enrolling the same id or key is still refused.

## 3. G3: `exclusive`, `PairingDuringKeyChangeError` and the recheck

**Within one engine instance there is no TOCTOU, deadlock or DoS.**
- **TOCTOU:** with a re-key queued behind a round, a code asked for afterwards runs after the commit and pairs at epoch 2 (`rr9-3 (a)`).
- **Deadlock:** the counter is decremented in `finally`, so a code works after a refused re-key (`rr9-3 (b)`). `pairingCode` rejects synchronously and never waits on the queue.
- **DoS:** only a hung provider call can keep `keyChanges` above 0, and the provider can refuse service anyway.

**H3 (low, pre-existing class): two tabs of one device.**
- #291 makes one `E2eeSync` per tab (`ui/session.ts:132`) over the same `idbStateStore`. Each tab caches the state (`loadState`) and has its own `keyChanges` and `exclusive`.
- `rr9-3 (c)`: while tab 1's revocation is stalled, tab 2 makes an **epoch-1 code**, and tab 1 commits epoch 2. The recheck at `engine.ts:935` reads tab 1's cached state, so it can't see the code.
- The same class lets tabs overwrite each other's `rekeyBlocked`, `revokedHere` and anchor.
- **Fix:** one engine per device (`navigator.locks` or a leader tab), or re-load the state in the pre-commit check.

**H5 (info):**
- Within one instance the recheck can never fire: every writer of `pairingUntil` is `exclusive`.
- When it does fire (lane K's test forces it), it leaves this device's own freeze in place, so every round stalls for `FREEZE_TTL_MS`.

## 4. G5: the remembered sealed-revoked set

**Can a forged keyring readmit a device? No avenue found.**
- `rr9-4 (a)`: a state reinstalled and re-paired from A refuses a keyring that drops the phone from `revoked` and enrolls its key as `phone-2`. The result is `KeyringForkError ["phone-2","phone"]`, and the phone gets no wrap.
- Forging needs S_N, and the parties that hold an older epoch's secret can only offer older keyrings, which the anchor refuses.
- A device that missed the revocation stays forkable. That is inherent and unchanged (spec §9).

**Can a legitimate un-revoke never happen? Yes, and that is intended.**
- `rr9-4 (b)`: a revoked device can't come back with the same id and key, the same key under a new id, or the same id with a new key. A new id with a new key enrolls.
- Spec §5 states this: "a revoked id or key can't be enrolled again". Honest re-keys already carried `priorRevoked` forward (`keyring.ts:690-703`); G5 only enforces it on the client.
- The user page doesn't say that a removed device has to be paired as a new device. This belongs to H5, and the fix is one doc line.

**Is the "set aside" path a downgrade? No.**
- A list whose MAC fails can only come from someone writing local state. That party could equally delete the list, and deletion was always accepted silently (`engine.ts:657`).
- `rr9-4 (c)`: a tampered list and a deleted list both still catch the readmission through `sealedRevoked`. The tampered case also gets a notice.
- Every revocation this device makes is adopted, so `sealedRevoked` covers `revokedHere`. The one gap is a state from before this build whose own revocation was overwritten by a fork. Seeding `sealedRevoked` from a verified `revokedHere` on first load would close it. Info, folded into H5.

## 5. The two changed `e2eeFifthReview` assertions

Neither is weaker.

| Assertion | Before | Now | Verdict |
|---|---|---|---|
| Readmit case | `revocationReapplied` was `["phone-2"]` | `["phone-2","phone"]` | **Stricter.** It expects one more re-revocation, because the forged keyring had also emptied the sealed list. The `phone-2` wrap is still asserted absent. |
| Tampered-list case | `KeyringForkError` (a wedge) | `revokedListReset === true`, then the list cleared, `sealedRevoked = ["phone"]`, and the notice said only once | **Intended behaviour change** (the G5 fix). The protection is still asserted: the fork check right after it is unchanged, and `rr9-4 (c)` shows the readmission is still caught. |

## 6. #529 `perf/encrypted-snapshot` @ `0d07aa216f`

### S1: HIGH — an encrypted vault's note text is written to IndexedDB in the clear

**Where:** `src/storage/workspaceIndex.ts:248` and `src/storage/vault/restStore.ts:51`.
- `snapshotMode()` returns plain mode (`{}`) whenever `storesMustSeal()` is false.
- `storesMustSeal()` returns false for an **unavailable** backend.
- The folder, desktop and mobile backends report `available: () => open` (`vault/location.ts`).

**Scenario:**
1. An unlocked encrypted vault is being edited.
2. The folder is disconnected or the vault is closed within the 5-second idle window.
3. The idle save then runs `saveSnapshot(vault, index.notes())` with no keys, which stores every indexed note's text and path in the clear.

**Test:** `rr9/r529-attack.test.ts (a)` FAILs in Chromium:
```
first save sealed: true | after unavailable: sealed false | plaintext present: true | {"v":1,"vault":"memory","paths":["notes/n9.md",...
```

**Why it blocks this PR:**
- The logic is inherited from #420's `snapshotAllowed` (same `storesMustSeal` test), so it is not new code.
- But this PR turns the snapshot on for encrypted vaults, rewrites this very function, and states "given keys, only a sealed record is written".
- A plaintext copy at rest is exactly what at-rest encryption exists to prevent.

**Fix:**
- An unavailable or unknown backend should mean `null`, so nothing is written.
- Better: fix the mode when the index is filled, and never save as plain an index that was filled from an encrypted vault.
- Also clear the in-memory index on lock and on a vault switch.

### What holds (S2, info)

| Question | Answer |
|---|---|
| HKDF domain separation | `info` is `lumen-rest/1/snapshot-enc` and `lumen-rest/1/snapshot-mac` (`format.ts:167`), with the same salt as `files`, `store` and `header`. The PR's test shows the `store` key can't decrypt a snapshot. |
| AES-GCM nonces across snapshot rewrites | A fresh random 96-bit nonce per seal. 2000 seals gave 2000 distinct nonces (`(c)`). With one seal per idle save, use stays far below 2^32 for the vault's lifetime. No nonce is ever derived or counted, so a rewrite can't reuse one. |
| Is the AAD binding complete? | It binds `sv`, `vaultId` and `vault` and is rebuilt from the caller (`snapshotSeal.ts:138`). A record relabelled for another workspace, or sealed under another key with the same `vaultId`, is refused. Time and generation are not bound; that is the accepted rollback (S3). |
| MAC-then-decrypt order and timing | Encrypt-then-MAC. The HMAC is checked with `subtle.verify` (constant time) before decryption. The distinct refusal reasons are only visible locally, so they are not an oracle. |
| Downgrade between plain and sealed | With keys, a plain record is refused and deleted. Without keys, a sealed record is refused and deleted. The remaining way to get a plain write in an encrypted vault is S1. |
| Key extractability | Both keys are `extractable: false`, from a non-extractable HKDF base (`format.ts:164`). They stay non-extractable after `structuredClone`, and `exportKey` is refused (`(c)`). The worker keeps no copy between requests. |
| Rolled-back snapshot | Accepted by design. `(b)`: with an older genuine record put back, an edit is read again and a deletion stays dropped. |
| Plaintext left behind | Conversion drops the plain snapshot (`session.ts` `migrateStores("seal")`). |

The PR's own `vaultSnapshotSealed` passes 9/9 in the same harness.

### Other #529 findings

- **S3 (low):** a stale snapshot can show wrong text only when the backend reports the same mtime for different content. That can happen on coarse-mtime filesystems or with mtime-preserving restore tools. The rule is inherited from #420 (`vaultIndexLocal.ts:34`). **Fix:** also compare size, or document it.
- **S4 (info):**
  - Deleting a record in IndexedDB does not erase it from disk.
  - A plain save already queued in the worker when the conversion runs can land after `dropSnapshot` (a narrow race). **Fix:** drop again once the conversion has finished and the worker queue has drained.

## 7. K5's numbers, rerun

I reran everything myself on all three heads (`$S/rr9/runs/all-{399,291,472}.out`). K5's table is confirmed.

| Suite | Result |
|---|---|
| rr7 | r7-1 2/2 · r7-2 1/1 · r7-3 2/2 · r7-4 1/2 ((a) is G4, inherent) · r7-5 3/3 · r5-7 head 3/3 |
| `.k4` copies | r5-1 5/5 · r5-2 2/2 · r5-4 3/3 |
| e2eeSeventhReview · e2eeFifthReview · e2eeThirdReview · e2eeRekeyIntegrity | 9/9 · 16/16 · 10/10 · 15/15 |
| e2eeKeyring · e2eeVectors · e2eeCrypto · e2eeAge · e2eeRandom | 6/6 · 5/5 · 12/12 · 5/5 · 1/1 |
| e2eeSync | 40/43 (the 3 ConflictDialog DOM cases, as on the base) |
| `check_vectors.py` | 31/31 |
| #291 | syncProviders 25/30 (DOMParser) · syncMigration 9/9 |
| #472 | syncProviders 17/22 (DOMParser) · syncMigration 9/9 |
| rr9 (all heads) | r9-1 0/4 · r9-2 1/2 · r9-3 2/3 · r9-4 3/3 |

## Receipts

Four `lumen-review` v1 receipts are in `$S/rr9/receipts/{399,291,472,529}.json`, written by `$S/rr9/mkreceipts.mjs`. I checked each with `receiptProblems` and `receiptFor` from `w-rr9-rr`, against the PR's current file list and CODEOWNERS:

| PR | Verdict | Check result |
|---|---|---|
| #399 | approve | no problems |
| #291 | approve | no problems |
| #472 | approve | no problems |
| #529 | changes-requested | gate blocked: "1 critical or high finding is open: S1" |
