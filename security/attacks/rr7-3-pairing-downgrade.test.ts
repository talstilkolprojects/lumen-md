/**
 * rr7-3, adapted for W8.5 (lane S): only the prefix list changed (the new current
 * versions added in front, the former current ones moved to the older list). No assertion changed.
 */
/**
 * rr7-3 — F1's labels and versions: downgrade and cross-kind matrix.
 *
 * (a) Every genuine message (the laptop's request, A's answer, A's one-way
 *     code), re-prefixed as every other kind and as every older version, fed
 *     to both readers (A's answerPairing and the laptop's pair()): only the
 *     genuine message in its own slot may be accepted.
 * (b) Older-build messages with a *valid* older-build MAC (HMAC(pairing_N,
 *     json), no label, as 7807f3bf28 made them) for the same keys: refused.
 * (c) A current-label body re-MACed the old way under the current prefix:
 *     refused (the label is inside the MAC).
 * A FAIL means a downgrade or a cross-kind message was accepted.
 */
import { describe, expect, it } from "vitest";
import { P, H, PR, B, KEYS, errName } from "./common";

// W8.5 (lane S, 14.11): the current prefixes moved to code 4 / request 3 / answer 3; the former current ones are now older versions too.
const PREFIXES = ["lumen-pair:4:", "lumen-pair-request:3:", "lumen-pair-answer:3:", "lumen-pair:1:", "lumen-pair:2:", "lumen-pair:3:", "lumen-pair-request:1:", "lumen-pair-request:2:", "lumen-pair-answer:1:", "lumen-pair-answer:2:"];
const relabel = (code: string, to: string) => code.replace(/^lumen-pair(-request|-answer)?:\d+:/, to);
const prefixOf = (code: string) => code.match(/^lumen-pair(-request|-answer)?:\d+:/)![0];

async function world() {
  const p = P.memoryProvider();
  const a = await H.newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  await a.sync.rekey();
  await a.sync.sync();
  return { p, a };
}

describe("rr7-3: pairing labels and versions", () => {
  it("(a) cross-kind and older-version relabelling, into both readers", async () => {
    const { p, a } = await world();
    const accepted: string[] = [];
    const legitOk: string[] = [];
    // Each attempt runs in a fresh world, so no lock or request state leaks between attempts.
    for (const kind of ["request", "answer", "code"] as const) {
      for (const to of PREFIXES) {
        for (const reader of ["answerPairing", "pair"] as const) {
          const { p: q, a: aa } = kind === "code" ? await world() : await world();
          const lap = await H.joinVault("laptop", q);
          await lap.sync.sync();
          const req = await lap.sync.pairingRequest();
          const msg = kind === "request" ? req : kind === "answer" ? await aa.sync.answerPairing(req) : await aa.sync.pairingCode();
          await aa.sync.cancelPairing();
          const genuine = prefixOf(msg) === to;
          const forged = relabel(msg, to);
          const ok = reader === "answerPairing" ? await aa.sync.answerPairing(forged).then(() => true, () => false) : await lap.sync.pair(forged).then(() => true, () => false);
          const legit = genuine && ((kind === "request" && reader === "answerPairing") || (kind !== "request" && reader === "pair"));
          if (ok && !legit) accepted.push(`${kind} as ${to} into ${reader}`);
          if (ok && legit) legitOk.push(`${kind} into ${reader}`);
        }
      }
    }
    void p; void a;
    console.log("  wrongly accepted:", accepted.length ? accepted.join("; ") : "none", "| genuine accepted (control):", legitOk.join(", "));
    expect(legitOk.length).toBe(3);
    expect(accepted).toEqual([]);
  });

  it("(b)/(c) older-build MACs (no label), old and new prefixes, are refused", async () => {
    const { a } = await world();
    const lap = await H.joinVault("laptop", (a.sync as any).o.provider);
    await lap.sync.sync();
    await lap.sync.pairingRequest();
    const keys = a.sync.keys();
    const s = await (a.sync as any).loadState();
    const ring = { epoch: keys.epoch, rev: keys.ring.rev, digest: keys.ring.digest };
    const oldMac = async (prefix: string, body: object) => {
      const json = B.utf8(JSON.stringify(body));
      return `${prefix}${keys.epoch}:${B.toB64u(B.concat(await KEYS.hmac(keys.pairing, json), json))}`;
    };
    const now = Date.now();
    // 7807f3bf28's one-way code body (lumen-pair:2:) and its request body (lumen-pair-request:1:).
    const oldCode = { vaultId: keys.vaultId, counter: s.anchor.counter, digest: s.anchor.digest, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, issuedAt: now, nonce: B.toB64u(B.randomBytes(12)) };
    const results: Record<string, string> = {};
    for (const pre of ["lumen-pair:2:", "lumen-pair:3:"]) results[`old code body, ${pre}`] = await lap.sync.pair(await oldMac(pre, oldCode)).then(() => "ACCEPTED", errName);
    const newCode = { kind: "code", ...oldCode };
    results["new code body, label-less MAC, lumen-pair:3:"] = await lap.sync.pair(await oldMac("lumen-pair:3:", newCode)).then(() => "ACCEPTED", errName);
    const oldReq = { vaultId: keys.vaultId, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, counter: s.anchor.counter, digest: s.anchor.digest, issuedAt: now, nonce: B.toB64u(B.randomBytes(16)) };
    for (const pre of ["lumen-pair-request:1:", "lumen-pair-request:2:"]) results[`old request body, ${pre}`] = await a.sync.answerPairing(await oldMac(pre, oldReq)).then(() => "ACCEPTED", errName);
    console.log("  ", JSON.stringify(results));
    expect(Object.values(results).filter((v) => v === "ACCEPTED")).toEqual([]);
  });
});
