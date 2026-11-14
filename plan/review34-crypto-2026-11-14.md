# Crypto review 34 (14.11): the W4.11 engine split, the K6 follow-ups and T5-1

I'm an independent reviewer and wrote none of this. I worked read-only: no pushes, no comments, no merges.

**Local-only side effects:**
- The T5 scratch test `src/__tests__/rr16-t5.attack.test.ts` is in the `w-rr34-472` worktree. It was never committed.
- `$S/rr34/bh` is a harness I copied while trying the UI suites. It didn't work for them; see I5.

**Heads** (checked with `gh api`):

| PR | Head | Worktree |
|---|---|---|
| #399 | `fa0fafd23db5268b361157c4ed84ca93e4c77d11` (split `a26f9af574`, K6 fixes `fa0fafd23d`) | `/home/claude/w-rr34-399` |
| #291 | `a9022ed90a8b7c531a8d4dd1f140dd7edc4511e1` | `/home/claude/w-rr34-291` |
| #472 | `5de689995ae4ec729c9006cb5050442a459067c0` (T5-1 = `4c8dc0e030`) | `/home/claude/w-rr34-472` |

- `S=/tmp/claude-0/-home-claude/db859785-2ec7-51e3-b6ba-0edfee54cc7b/scratchpad`.
- To run: `$S/rr34/run.sh <worktree> <test>`; `$S/rr34/all.sh` runs everything, and the logs are in `$S/rr34/runs/`.
- **A FAIL means the attack worked.**

## Verdict

| PR | Verdict | Open findings |
|---|---|---|
| #399 | **approve** | K34-1 low · K34-2, W4.11 info |
| #291 | **approve** | the same, through the merge |
| #472 | **approve** | the same, through the merge; T5-1 fixed |

- No critical or high finding is open, and K6-1, K6-2, K6-3 and T5-1 are fixed.
- **Condition** for a revoke or re-key UI: K34-1, together with review 27's S27-1 and S27-2 once SAS lands, plus RR-10 and I5 as before.

## 1. The split (W4.11) changes no behaviour

**Method.** `rr34/split/members.py` pulls out every method and function body from `engine.ts` and `keyring.ts` at `dd6d757786`, and from the seven modules at `a26f9af574`. It strips comments, whitespace and visibility modifiers, then compares the two sets.

| Check | Result |
|---|---|
| Lost or added members | none |
| Bodies changed | none |
| Exports | no export of `engine.ts` or `keyring.ts` lost; `engine.ts` re-exports the vaultOpen functions, and the keyring errors are re-exported from `keyringErrors.ts` |
| Initialisation order | the only constructor and **every** instance field are in the base class `E2eeSyncCore`. With `useDefineForClassFields: true` and ES2022, no derived class re-declares a field, so nothing set by the base constructor is reset to `undefined`. The base constructor calls no overridable method. The two abstract members (`rekeyNow`, `reapplyRevocation`) are implemented in `E2eeSyncKeys`. |
| `private` → `protected` widening | 37 members, from `loadState` and `save` to `rekeyNow`, `refresh`, `exclusive`, `underDeviceLock` and `callOffFreeze`. Details below. |

**On the widening (info):**
- At runtime it changes nothing: TypeScript's `private` was never enforced, and no `#` fields were involved.
- Nothing in the tree extends `E2eeSync`.
- But a future subclass could call `rekeyNow` without `exclusive` or the lock, so mark these members `@internal`, or add a lint rule against extending `E2eeSync`.

## 2. K6-1: rounds and pairing paths take the lock and re-read the state — fixed, with a liveness cost

**What now runs under the lock and re-reads the state:**
- the round;
- `markCreated`, `confirmFreshness`, `pairingRequest`, `pair`, `cancelPairing` and `enroll`.

**Results:**
- **rr16-3 (a)** now passes: a stale tab no longer drops `revokedHere` or `rekeyed`.
- **Re-entry works.** `lockHeld` makes the nested `rekeyNow` reached from `enforceRevocations` skip the lock it already holds. A round over a readmitting keyring completes with `KeyringForkError`, and the phone is revoked again at epoch 3 (`rr34 (d)`).
- **No deadlock.** There is a single lock per vault, so there is no lock ordering to get wrong (`rr16-3 (c)`, review 16).

**K34-1 — LOW — a hung round now blocks every tab's key changes.**
- A round holds the lock for its whole duration. A round stuck on a storage request that never answers (there is no request timeout) blocks key changes, revocations included, in every tab until that tab closes.
- `rr34 (a)`: tab 2's revocation is still waiting after 10 s, and the wait has no bound.
- Before this change only key changes held the lock.
- The storage gains no new power from this: it could always stall the revocation's own requests. The new problem is that an unrelated stuck background tab now blocks an urgent revocation.
- **Fix:** add a timeout to provider calls made under the lock, or bound how long a key change waits for a round's lock.

**K34-2 — INFO — pairing refused with the wrong message while another tab syncs.**
- While any tab runs a round, a pairing code or answer is refused at once with `PairingDuringKeyChangeError` ("changing keys") (`rr34 (b)`).
- The message is wrong for a round. With several tabs syncing, pairing can keep failing and the user is told the wrong reason.
- **Fix:** a separate "busy, try again" error, or a short wait for a round's lock (but not a key change's).

## 3. K6-3: the lock no longer depends on a cached device id — fixed

- With Web Locks, the lock is named by the vault alone: `lumen-e2ee-device:<vaultId>`. Every tab of an origin is the same device, so that is the right scope.
- Without Web Locks, the in-page fallback names it by the vault plus an id for the state-store object, so simulated devices in one test stay separate.
- rr16-3 (b) passes: two tabs on a fresh store now share the lock.
- **Info:** in the fallback, two store objects over the same IndexedDB in one page would get different lock names. Every supported browser has Web Locks, so this only matters for the documented fallback.

## 4. K6-2: the new "contested" rule — fixed

**The rule.** A lost commit now counts towards `RevocationContestedError` only when the live keyring:
- differs from the one this device re-keyed from;
- opens under the epoch's keys (the AEAD seal, so only a key holder can make it);
- has a later revision.

**Can a provider still fake it?** No. rr16-2 gives 3/3: fake 412s and a served older revision now stay a plain `PreconditionFailedError`.

**Can a provider suppress a real one?**
- Not with a single hide. In `rr34 (c)` the phone rewrites the keyring on every try and the provider serves the old keyring at the check right after one loss. The result is still `PreconditionFailedError | RevocationContestedError | RevocationContestedError`.
- A provider that hides every rewrite can suppress the hint completely.
- A provider that kept genuine later revisions (real rewrites by key holders, for example an honest enrollment) can replay them so they count.
- Both cases need the provider, and both only change the message; the outcome (a failed commit) is the same. Info.

## 5. T5-1 — fixed

- `finishDisable` now stops auto-lock only when no session is still unlocked.
- `rr16-t5` gives 2/2 (auto-lock intervals 1 → 1 after turning B's encryption off, and an idle check locks A).
- vaultEncryption gives 30/30 in Chromium.

## 6. The mutation tests — behavioural

`e2eeKeyringEdges` has 5 cases, and its file is blob-identical on #399 and in the mutation commit. Each one checks a real property:

| Case | What it checks |
|---|---|
| Nonce size | the 96-bit AES-GCM nonce of the sealed contents and of the passphrase wrap |
| Marker cap | the `DROPPED_LENGTH` cap at its boundary: exactly the cap is accepted, one more is refused |
| `verifyDropped` | its conditions: the named device, the first epoch the device lacks, and the MAC |
| `rewriteKeyring` | it refuses stale keys and writes nothing |
| `confirmCommit` | with no key access, it accepts its own bytes and rejects others |

None of them is tied to the text of a particular mutant.

**`targets.json`:**
- The change only adds test files to the mutation sets of `keyring.ts` and `keyringErrors.ts`: the edges suite, Seventh "G2" and Fifth "F4".
- No module was removed, and the critical floor is unchanged at 80.
- The commit (`45aabf7f15`, and two earlier variants of it) isn't on any pushed branch yet. Review it again when it lands on the train.

## 7. Reruns (all three heads, plain Node with the shim)

| Suite | #399 | #291 | #472 |
|---|---|---|---|
| e2eeKeyringEdges · Ninth · Seventh · Fifth · Third · RekeyIntegrity | 5/5 · 10/10 · 9/9 · 16/16 · 10/10 · 15/15 | same | same |
| e2eeKeyring · Sync · Vectors · Crypto · Age · Random | 6/6 · 40/43 (ConflictDialog DOM) · 5/5 · 12/12 · 5/5 · 1/1 | same | same |
| syncProviders · syncMigration | — | 25/30 (DOMParser) · 9/9 | 17/22 (DOMParser) · 9/9 |
| `check_vectors.py` | 31/31 | 31/31 | 31/31 |
| rr16-2 · rr16-3 | **3/3 · 3/3** (were 1/3 · 1/3) | same | same |
| rr34-1 | 2/4 ((a) K34-1, (b) K34-2) | same | same |
| rr9-1 · 2 · 3 · 4 | 3/4 ((c) inherent) · 1/2 (H4, info) · 3/3 · 3/3 | same | same |
| rr7 r7-1 · 2 · 3 · 4 · 5 · r5-7 | 2/2 · 1/1 · 2/2 · 1/2 (G4; fixed by #544) · 3/3 · 3/3 | same | same |
| `.k4` copies r5-1 · r5-2 · r5-4 | 5/5 · 2/2 · 3/3 | same | same |
| rr16-t5 · vaultEncryption (Chromium) | — | — | 2/2 · 30/30 |

**I5:** e2eeUi and syncPanel still can't run offline. Neither Chromium harness provides a working testing-library (`render`, `getByLabelText`), so they need real vitest with jsdom. That stays owed, together with the real-server probe runs and the Sandbox run.

## Receipts

`$S/rr34/receipts/{399,291,472}.json` (`lumen-review` v1), written by `$S/rr34/mkreceipts.mjs`. I checked each with `receiptProblems` and `receiptFor` from `w-rr9-rr` against the PR's current file list:

| PR | Verdict | Check result |
|---|---|---|
| #399 | approve | no problems |
| #291 | approve | no problems |
| #472 | approve | no problems |
