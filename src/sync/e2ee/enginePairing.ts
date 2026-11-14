/**
 * The encrypted sync engine: pairing (third review N3, fifth review F1,
 * seventh review G3, ninth review H3) and the comparison that has to happen
 * before a pairing commits (plan W8.5, seventh review G4; review 13 S13-1).
 * Split out of engineKeys.ts to keep each module under 800 lines.
 *
 * The comparison (sas.ts, spec §6a): both devices show five symbols derived
 * from a fresh X25519 exchange and the whole transcript. The new device (the
 * joiner) takes the anchors only once the user said "They match" on both
 * devices and the existing device's (the issuer's) confirmation verifies.
 * The issuer confirms last: it posts its confirmation only after the
 * joiner's has verified, and from then on holds back key changes for the
 * joiner's whole window (`pairingKept`), cancel or not. The joiner's window
 * ends when the code or answer expires. So whenever a joiner can still
 * commit, the issuer makes no key change.
 */

import { fromB64u, utf8 } from "./bytes";
import { anchorOf, KeyringForkError, sealAnchor, verifyAnchor, type RingAnchor } from "./keyring";
import { opaqueName } from "./keys";
import { RollbackError, type FreshnessAnchor } from "./manifest";
import {
  createPairingAnswer,
  createPairingCode,
  createPairingConfirm,
  createPairingRequest,
  createPairingReveal,
  isPairingAnswer,
  PAIRING_CLOCK_SKEW_MS,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_TTL_MS,
  PairingEpochError,
  PairingError,
  pairingRequestHash,
  readPairingAnswer,
  readPairingCode,
  readPairingConfirm,
  readPairingRequest,
  readPairingReveal,
  type PairingOffer,
} from "./pairing";
import { confirmTag, confirmValid, deriveSas, SAS_EMOJI, sasCommit, sasKeyPair, type PairingFlow, type PairingRole, type Sas, type SasTranscript } from "./sas";
import type { DeviceState } from "./state";
import { PairingAbortedError, PairingDuringKeyChangeError, type PairingComparison } from "./engineTypes";
import { E2eeSyncKeys } from "./engineKeys";

type PairObject = "reveal-issuer" | "reveal-joiner" | "confirm-issuer" | "confirm-joiner";

/** An issuing device's side of a pairing (memory only: a restart ends it, and its code or answer can't complete). */
interface IssuerSession {
  flow: PairingFlow;
  session: string;
  answer: string;
  nonce: string;
  expires: number;
  priv: CryptoKey;
  pub: Uint8Array;
  /** The keyring and manifest the code or answer vouches for. */
  ring: RingAnchor;
  anchor: FreshnessAnchor;
  /** Two-way: the new device's commitment, from the request. */
  commitJ?: string;
  sas?: Sas;
  /** This device's clock: the code or answer stops holding. */
  until: number;
  /** `pairingUntil` before this session: restored when it ends unconfirmed. */
  prevUntil: number | undefined;
}

/** The new device's side: the offer read, not committed until both users confirmed. */
interface JoinerSession {
  flow: PairingFlow;
  offer: PairingOffer;
  priv: CryptoKey;
  pub: Uint8Array;
  pubI?: Uint8Array;
  sas?: Sas;
  /** This device's clock: after this the comparison can't commit. */
  until: number;
  confirmed?: boolean;
}

const ABORTED_MISMATCH = "The other device's confirmation doesn't match this pairing, so nothing was paired. Start again, and pair only with the device in front of you.";

export abstract class E2eeSyncPairing extends E2eeSyncKeys {
  /** This device's pairing in progress (W8.5), as the existing device or as the new one. */
  private issuing: IssuerSession | null = null;
  private joining: JoinerSession | null = null;
  /** The comparison key made with this device's two-way request (W8.5). */
  private requestKey: { hash: string; priv: CryptoKey; pub: Uint8Array } | null = null;

  /**
   * A pairing code for a new device, carrying this device's newest verified
   * anchors: the manifest and the keyring, and a commitment to this
   * device's comparison key (W8.5). An unverified (TOFU) device cannot issue
   * one: it would pass on a state nobody verified as if it had been.
   */
  pairingCode(): Promise<string> {
    // Seventh review 12.11, G3: serialised with key changes. A key change
    // running now (its keyring write may be stalled) would make the code
    // vouch for the epoch it is replacing: refused at once, not queued.
    if (this.keyChanges > 0) return Promise.reject(new PairingDuringKeyChangeError());
    // H3: nor while another tab of this device changes keys (the device lock).
    return this.exclusive(() =>
      this.pairingUnderLock(async (s) => {
        if (!s.anchor) throw new PairingError("Sync once before pairing another device");
        if (s.freshness === "unverified") {
          throw new PairingError("This device's freshness is not verified: pair it or confirm it before pairing others");
        }
        const now = this.o.now();
        const ring = anchorOf(this.o.keys);
        const { priv, pub } = await sasKeyPair();
        const code = await createPairingCode(this.o.keys, s.anchor, now, ring, await sasCommit(pub));
        const read = await readPairingCode(this.o.keys, code, now);
        await this.endIssuing();
        this.issuing = { flow: "one-way", session: read.sas.session, answer: "", nonce: read.sas.nonce, expires: read.sas.expires, priv, pub, ring, anchor: { ...s.anchor }, until: now + PAIRING_TTL_MS, prevUntil: s.pairingUntil };
        s.pairingUntil = Math.max(s.pairingUntil ?? 0, now + PAIRING_TTL_MS); // N3: no key change while it is valid
        await this.save();
        return code;
      }),
    );
  }

  /**
   * Two-way pairing, step 1, on the new device (third review 12.11, N3): a
   * request naming the keyring and manifest this device sees now, and a
   * commitment to its comparison key (W8.5). The user enters it on an
   * existing device (`answerPairing`), and that device's answer here (`pair`).
   */
  pairingRequest(): Promise<string> {
    return this.exclusive(async () => {
      await this.refresh();
      const s = await this.loadState();
      const { priv, pub } = await sasKeyPair();
      const { code, request } = await createPairingRequest(this.o.keys, s.anchor, this.o.now(), anchorOf(this.o.keys), await sasCommit(pub));
      await this.endJoining();
      this.requestKey = { hash: request.hash!, priv, pub };
      s.pairRequest = request;
      await this.save();
      return code;
    });
  }

  /**
   * Two-way pairing, step 2, on an existing, verified device: check the new
   * device's request against this device's *current* keyring and manifest —
   * read now, not when anything was issued — and answer with them and this
   * device's comparison key, bound to the request. A new device shown an
   * older epoch or revision is refused here (`PairingEpochError("older")`),
   * whichever device made the newer one.
   */
  answerPairing(request: string): Promise<string> {
    // H3: not while another tab of this device changes keys (the device lock).
    return this.exclusive(() =>
      this.pairingUnderLock(async (s) => {
        if (s.freshness === "unverified") throw new PairingError("This device's freshness is not verified: pair it or confirm it before pairing others");
        await this.refresh();
        await this.readManifest();
        if (!s.anchor) throw new PairingError("Sync once before pairing another device");
        const req = await readPairingRequest(this.o.keys, request);
        const mine = anchorOf(this.o.keys);
        if (req.ring.epoch === mine.epoch && req.ring.digest !== mine.digest) {
          if (req.ring.rev < mine.rev) {
            throw new PairingEpochError("older", `The new device is shown an older version of the keys (${mine.epoch}.${req.ring.rev}; this device is at ${mine.epoch}.${mine.rev}): the storage is showing it old keys. Don't pair it; sync it and try again.`);
          }
          if (req.ring.rev === mine.rev) throw new KeyringForkError(`the new device sees another keyring at ${mine.epoch}.${mine.rev}`);
          throw new PairingEpochError("newer", "The new device sees newer keys than this one: sync this device, then enter the request again");
        }
        if (req.manifest && req.manifest.counter > s.anchor.counter) throw new PairingEpochError("newer", "The new device sees newer notes than this one: sync this device, then enter the request again");
        const now = this.o.now();
        const { priv, pub } = await sasKeyPair();
        const answer = await createPairingAnswer(this.o.keys, req, s.anchor, now, mine, pub);
        await this.endIssuing();
        this.issuing = {
          flow: "two-way",
          session: req.hash!,
          answer: await pairingRequestHash(answer),
          nonce: req.nonce,
          expires: now + PAIRING_REQUEST_TTL_MS,
          priv,
          pub,
          ring: mine,
          anchor: { ...s.anchor },
          commitJ: req.commit!,
          until: now + PAIRING_REQUEST_TTL_MS,
          prevUntil: s.pairingUntil,
        };
        s.pairingUntil = Math.max(s.pairingUntil ?? 0, now + PAIRING_REQUEST_TTL_MS);
        await this.save();
        return answer;
      }),
    );
  }

  /**
   * Call off this device's pairing (info I3): its comparison ends, so the
   * codes and answers it gave out can no longer be confirmed and stop
   * holding back its key changes — an urgent revocation needn't wait up to
   * 5 minutes — and a request it is waiting to have answered is forgotten.
   * One exception (W8.5, review 13 S13-1): a pairing this device already
   * confirmed keeps holding key changes until the new device's window ends
   * (`pairingKept`), since the new device holds that confirmation.
   */
  cancelPairing(): Promise<void> {
    return this.exclusive(() =>
      this.underDeviceLock(true, async () => {
        const s = await this.loadState();
        await this.endIssuing();
        await this.endJoining();
        this.requestKey = null;
        delete s.pairingUntil;
        delete s.pairRequest;
        await this.save();
      }),
    );
  }

  /**
   * Read a pairing code, or the answer to this device's request, from an
   * existing device, and start the comparison (plan W8.5). Nothing is
   * committed here: every check runs now (and again at the commit), this
   * device's comparison key goes to the storage, and the anchors are taken
   * only by `confirmPairing`. Resolves without a comparison when this device
   * is verified and already holds a newer state than the code.
   */
  pair(code: string): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.loadState();
      // F6: the keys must reproduce the anchor this device verified before
      // anything is sealed with them (a state from before N1 has no check:
      // the refresh seals it, as every other entry point does).
      if (s.ring && !(await verifyAnchor(this.o.keys, s.ring))) await this.refresh();
      const answer = isPairingAnswer(code);
      // A one-way code, or the answer to this device's own request (N3).
      const now = this.o.now();
      const got = answer ? await readPairingAnswer(this.o.keys, code, s.pairRequest ?? null, now) : await readPairingCode(this.o.keys, code, now);
      if (this.checkOffer(s, got) === "nothing") return;
      await this.endJoining();
      if (answer) {
        const k = this.requestKey;
        if (!k || k.hash !== s.pairRequest?.hash) throw new PairingAbortedError("This device was restarted after it made its pairing request: make a new request and answer it again");
        const pubI = fromB64u(got.sas.pub!);
        // S13-1: no later than the request's life on this clock (the answer came after it).
        const session: JoinerSession = { flow: "two-way", offer: got, priv: k.priv, pub: k.pub, pubI, until: s.pairRequest!.issuedAt + PAIRING_REQUEST_TTL_MS };
        session.sas = await deriveSas(k.priv, pubI, this.transcript(session.flow, got, pubI, k.pub));
        this.joining = session;
      } else {
        const { priv, pub } = await sasKeyPair();
        // S13-1: the window ends with the code, not 2 minutes after it was entered.
        this.joining = { flow: "one-way", offer: got, priv, pub, until: Math.min(now + PAIRING_TTL_MS, got.sas.expires) };
      }
      await this.o.provider.put(await this.pairName(got.sas.session, "reveal-joiner"), utf8(await createPairingReveal(this.o.keys, got.sas.session, "joiner", this.joining.pub)));
    });
  }

  /**
   * The checks a code or answer must pass against this device's state, at
   * `pair` and again at the commit. "nothing": a verified device that
   * already holds a newer state needs nothing from it.
   */
  private checkOffer(s: DeviceState, got: PairingOffer): "ok" | "nothing" {
    // The keyring: same epoch (readPairingCode checks it); the same revision must be the same keyring.
    const mine = s.ring ?? anchorOf(this.o.keys);
    if (got.ring.epoch === mine.epoch && got.ring.rev === mine.rev && mine.digest && got.ring.digest !== mine.digest) {
      throw new KeyringForkError(`the pairing code names another keyring at ${mine.epoch}.${mine.rev}`);
    }
    // Never move the anchor backwards; equal counters must be the same manifest.
    if (s.anchor && got.counter === s.anchor.counter && got.digest !== s.anchor.digest) {
      throw new RollbackError(s.anchor.counter, got.counter, "fork");
    }
    if (s.anchor && got.counter < s.anchor.counter) {
      // An older code cannot vouch for the newer state this device already
      // holds (it may come from another fork). A verified device needs
      // nothing from it; an unverified one needs a current code.
      if (s.freshness !== "unverified") return "nothing";
      throw new PairingError("The pairing code is older than this device's state; create a new code on the other device");
    }
    return "ok";
  }

  /** The transcript both devices derive the symbols from (sas.ts). */
  private transcript(flow: PairingFlow, got: PairingOffer, pubI: Uint8Array, pubJ: Uint8Array): SasTranscript {
    return { flow, vaultId: this.o.keys.vaultId, epoch: got.ring.epoch, ringRev: got.ring.rev, ringDigest: got.ring.digest, counter: got.counter, digest: got.digest, session: got.sas.session, answer: got.sas.answer, nonce: got.sas.nonce, pubI, pubJ };
  }

  private pairName(session: string, what: PairObject): Promise<string> {
    return opaqueName(this.o.keys, `pairing/${session}/${what}`);
  }

  private async readPairObject(session: string, what: PairObject): Promise<string | null> {
    const obj = await this.o.provider.get(await this.pairName(session, what));
    return obj ? new TextDecoder().decode(obj.data) : null;
  }

  /** Remove the comparison's objects this device wrote (best effort: they hold public keys and MACs only). */
  private async dropPairObjects(session: string, role: PairingRole): Promise<void> {
    for (const what of [`reveal-${role}`, `confirm-${role}`] as const) await this.o.provider.delete(await this.pairName(session, what)).catch(() => undefined);
  }

  /** End this device's issuing session; unless `kept`, its hold on key changes goes back to what it was before it. */
  private async endIssuing(kept = false): Promise<void> {
    const i = this.issuing;
    if (!i) return;
    this.issuing = null;
    if (!kept) {
      const s = await this.loadState();
      if (i.prevUntil === undefined) delete s.pairingUntil;
      else s.pairingUntil = i.prevUntil;
      await this.dropPairObjects(i.session, "issuer");
    }
  }

  private async endJoining(): Promise<void> {
    const j = this.joining;
    if (!j) return;
    this.joining = null;
    await this.dropPairObjects(j.offer.sas.session, "joiner");
  }

  /** The issuing session, if it may still go on: not expired, and this device's keys are those it vouched for. */
  private async liveIssuing(): Promise<IssuerSession | null> {
    const i = this.issuing;
    if (!i) return null;
    const ring = anchorOf(this.o.keys);
    if (this.o.now() > i.until || ring.epoch !== i.ring.epoch || ring.rev !== i.ring.rev || ring.digest !== i.ring.digest) {
      await this.endIssuing();
      await this.save();
      return null;
    }
    return i;
  }

  /**
   * The symbols to compare (plan W8.5), on either device: null until the
   * other device's key has arrived through the storage (poll), or when this
   * device has no pairing in progress.
   */
  pairingSas(): Promise<PairingComparison | null> {
    return this.exclusive(async () => {
      const j = this.joining;
      if (j) {
        if (!j.sas) {
          const text = await this.readPairObject(j.offer.sas.session, "reveal-issuer");
          if (!text) return null;
          const pubI = await readPairingReveal(this.o.keys, text, j.offer.sas.session, "issuer");
          if ((await sasCommit(pubI)) !== j.offer.sas.commit) return null; // not the key the code committed to
          j.pubI = pubI;
          j.sas = await deriveSas(j.priv, pubI, this.transcript(j.flow, j.offer, pubI, j.pub));
        }
        return { role: "joiner", symbols: j.sas.symbols, emoji: j.sas.symbols.map((n) => SAS_EMOJI[n]!) };
      }
      const i = await this.liveIssuing();
      if (!i) return null;
      if (!i.sas) {
        const text = await this.readPairObject(i.session, "reveal-joiner");
        if (!text) return null;
        const pubJ = await readPairingReveal(this.o.keys, text, i.session, "joiner");
        if (i.flow === "two-way" && (await sasCommit(pubJ)) !== i.commitJ) return null; // not the key the request committed to
        const offer: PairingOffer = { counter: i.anchor.counter, digest: i.anchor.digest, ring: i.ring, sas: { session: i.session, answer: i.answer, nonce: i.nonce, expires: i.expires } };
        i.sas = await deriveSas(i.priv, pubJ, this.transcript(i.flow, offer, i.pub, pubJ));
        // One-way: the key the code committed to, now that the new device's key is fixed.
        if (i.flow === "one-way") await this.o.provider.put(await this.pairName(i.session, "reveal-issuer"), utf8(await createPairingReveal(this.o.keys, i.session, "issuer", i.pub)));
      }
      return { role: "issuer", symbols: i.sas.symbols, emoji: i.sas.symbols.map((n) => SAS_EMOJI[n]!) };
    });
  }

  /**
   * The user says the symbols match on both devices (plan W8.5). Under the
   * device lock, on the state as stored (ninth review H3).
   *
   * - The new device posts its confirmation, and commits (after the same
   *   checks as `pair`, within its window) once the existing device's
   *   confirmation verifies: "done". Until then "waiting": call again.
   * - The existing device confirms last (review 13, S13-1): "waiting" until
   *   the new device's confirmation is there and verifies; then it keeps
   *   holding key changes for the new device's whole window, posts its own
   *   confirmation and says "done". It commits nothing itself.
   */
  confirmPairing(): Promise<"done" | "waiting"> {
    return this.exclusive(() => this.underDeviceLock(true, () => (this.joining ? this.confirmJoining(this.joining) : this.confirmIssuing())));
  }

  private async confirmJoining(j: JoinerSession): Promise<"done" | "waiting"> {
    const s = await this.loadState();
    if (!j.sas) throw new PairingError("Compare the symbols on both devices first");
    if (this.o.now() > j.until) {
      await this.endJoining();
      throw new PairingAbortedError("The pairing has expired, so nothing was paired; start again");
    }
    const session = j.offer.sas.session;
    if (!j.confirmed) {
      await this.o.provider.put(await this.pairName(session, "confirm-joiner"), utf8(await createPairingConfirm(this.o.keys, session, "joiner", await confirmTag(j.sas, "joiner"))));
      j.confirmed = true;
    }
    const text = await this.readPairObject(session, "confirm-issuer");
    if (!text) return "waiting";
    const tag = await readPairingConfirm(this.o.keys, text, session, "issuer").catch(() => null);
    if (!tag || !(await confirmValid(j.sas, "issuer", tag))) {
      await this.endJoining();
      throw new PairingAbortedError(ABORTED_MISMATCH);
    }
    // Both users confirmed: commit, after the same checks as `pair`.
    this.joining = null;
    if (j.flow === "two-way") {
      if (!s.pairRequest || s.pairRequest.hash !== session) throw new PairingAbortedError("This device's pairing request was replaced; start again");
      delete s.pairRequest;
      this.requestKey = null;
    }
    for (const what of ["reveal-joiner", "confirm-joiner", "reveal-issuer", "confirm-issuer"] as const) await this.o.provider.delete(await this.pairName(session, what)).catch(() => undefined);
    const got = j.offer;
    if (this.checkOffer(s, got) === "ok") {
      const mine = s.ring ?? anchorOf(this.o.keys);
      const ringNewer = got.ring.epoch > mine.epoch || (got.ring.epoch === mine.epoch && got.ring.rev > mine.rev);
      s.anchor = { counter: got.counter, digest: got.digest };
      if (got.ring.epoch > 0 && (ringNewer || !s.ring)) s.ring = await sealAnchor(got.ring, this.o.keys.secret, this.o.keys.vaultId);
      s.freshness = "paired";
    }
    await this.save();
    return "done";
  }

  private async confirmIssuing(): Promise<"done" | "waiting"> {
    const i = await this.liveIssuing();
    if (!i) throw new PairingAbortedError("This device has no pairing in progress (it was cancelled, it expired, or this device's keys changed): start again");
    if (!i.sas) throw new PairingError("Compare the symbols on both devices first");
    const text = await this.readPairObject(i.session, "confirm-joiner");
    if (!text) return "waiting"; // S13-1: the issuer confirms last
    const tag = await readPairingConfirm(this.o.keys, text, i.session, "joiner").catch(() => null);
    if (!tag || !(await confirmValid(i.sas, "joiner", tag))) {
      await this.endIssuing();
      await this.save();
      throw new PairingAbortedError(ABORTED_MISMATCH);
    }
    // From the moment the confirmation is out, the new device may commit until
    // its window ends: hold key changes until then (its clock may be behind
    // this one by up to PAIRING_CLOCK_SKEW_MS), and a cancel doesn't release it.
    const s = await this.loadState();
    s.pairingKept = Math.max(s.pairingKept ?? 0, i.until + PAIRING_CLOCK_SKEW_MS);
    await this.save();
    await this.o.provider.put(await this.pairName(i.session, "confirm-issuer"), utf8(await createPairingConfirm(this.o.keys, i.session, "issuer", await confirmTag(i.sas, "issuer"))));
    await this.endIssuing(true);
    return "done";
  }

  /**
   * The user says the symbols differ, or stops the comparison (plan W8.5):
   * this device's side ends and records nothing. On the new device the
   * request is forgotten; on the existing one the code or answer can no
   * longer be confirmed, so it stops holding back key changes (a pairing it
   * already confirmed keeps `pairingKept`).
   */
  rejectPairing(): Promise<void> {
    return this.exclusive(() =>
      this.underDeviceLock(true, async () => {
        const s = await this.loadState();
        if (this.joining) {
          if (this.joining.flow === "two-way") {
            delete s.pairRequest;
            this.requestKey = null;
          }
          await this.endJoining();
        }
        await this.endIssuing();
        await this.save();
      }),
    );
  }

  /** The user confirmed by hand (e.g. compared with another device) that the vault is current. */
  confirmFreshness(): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.loadState();
      if (!s.anchor) throw new Error("Nothing to confirm yet: sync once first");
      if (s.freshness === "unverified") s.freshness = "confirmed";
      await this.save();
    });
  }
}
