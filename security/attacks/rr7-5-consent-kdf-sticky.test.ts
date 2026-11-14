/**
 * rr7-5 — F3 consent, F5 "unverifiable header counts as Argon2id", F2's
 * local list when it is lost.
 *
 * (a) consent bypass: an unverified device's re-key that revokes one device
 *     or enrolls another must still ask before leaving the rest out.
 * (b) F5 on a PBKDF2 vault: a header the storage garbles for that one read
 *     moves the next passphrase to Argon2id (an upgrade, never a downgrade),
 *     and the vault opens with the new passphrase.
 * (c) F2's revokedHere is authenticated against change, not against loss: a
 *     restored or reinstalled state without it accepts a keyring that lets
 *     the revoked phone back in (only a holder of the epoch's secret can make
 *     one, i.e. a CAS-lie sibling). Documents the residue.
 * A FAIL means the property doesn't hold.
 */
import { describe, expect, it } from "vitest";
import { P, E, K, AGE, H, B, wrapFor, errName } from "./common";

async function withDevices() {
  const p = P.memoryProvider();
  const a = await H.newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await AGE.generateIdentity();
  const tablet = await AGE.generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient, tablet: tablet.recipient } });
  await a.sync.sync();
  return { p, a, phone, tablet };
}

describe("rr7-5", () => {
  it("(a) an unverified re-key that revokes or enrolls still needs consent to leave the others out", async () => {
    const { p } = await withDevices();
    const u = await H.joinVault("U", p);
    await u.sync.sync();
    const extra = await AGE.generateIdentity();
    const e1 = await u.sync.rekey({ revoke: ["tablet"] }).then(() => null, (e) => e);
    const e2 = await u.sync.rekey({ enroll: { laptop: extra.recipient } }).then(() => null, (e) => e);
    const e3 = await u.sync.rekey({ newPassphrase: "another passphrase, long enough 2026" }).then(() => null, (e) => e);
    console.log("  revoke tablet:", errName(e1), JSON.stringify(e1?.devices), "| enroll laptop:", errName(e2), JSON.stringify(e2?.devices), "| passphrase change:", errName(e3), JSON.stringify(e3?.devices));
    expect(e1).toBeInstanceOf(E.DropDevicesRequiredError);
    expect(e1.devices).toEqual(["phone"]);
    expect(e2).toBeInstanceOf(E.DropDevicesRequiredError);
    expect([...e2.devices].sort()).toEqual(["phone", "tablet"]);
    expect(e3).toBeInstanceOf(E.DropDevicesRequiredError);
  });

  it("(b) PBKDF2 vault, header garbled for the one read: Argon2id, and the new passphrase opens it", async () => {
    const p = P.memoryProvider();
    const a = await H.newVault(p); // PBKDF2 (test iterations)
    await a.sync.sync();
    let garble = true;
    const q = { ...p, objects: p.objects, get: async (n: string) => { const r = await p.get(n); if (n === "lumen-e2ee-vault" && garble && r) { garble = false; return { ...r, data: B.utf8("{\"format\":\"x\"}") }; } return r; }, put: p.put.bind(p), delete: p.delete.bind(p), list: p.list.bind(p) };
    const d = H.device("A2", q, a.sync.keys());
    d.store.state = JSON.parse(JSON.stringify(a.store.state));
    const before = JSON.parse(B.fromUtf8(p.objects.get("lumen-e2ee-vault")!.data)).kdf.alg;
    const NEW = "the new passphrase for this vault 2026";
    const r = await d.sync.rekey({ newPassphrase: NEW }).then((x) => x, (e) => e);
    const after = JSON.parse(B.fromUtf8(p.objects.get("lumen-e2ee-vault")!.data)).kdf;
    const opens = await E.unlockVault(p, NEW, H.TEST_POLICY).then(() => "opens", errName);
    console.log("  before:", before, "| re-key:", (r as { epoch?: number }).epoch ?? errName(r), "| after:", after.alg, "| new passphrase:", opens, "| garbled read used:", !garble);
    expect(after.alg).toBe("argon2id");
    expect(opens).toBe("opens");
  });

  it("(c) revokedHere lost (restored state): a keyring that lets the phone back in is no longer caught", async () => {
    const { p, a, phone } = await withDevices();
    await a.sync.rekey({ revoke: ["phone"] });
    await a.sync.sync();
    const keys = a.sync.keys();
    await K.rewriteKeyring(p, keys, { wrap: keys.wrap }, (c: any, f: any) => ({ contents: { ...c, revoked: [], devices: { ...c.devices, phone: phone.recipient } }, file: f }));
    const withList = H.device("A", p, a.sync.keys());
    withList.store.state = JSON.parse(JSON.stringify(a.store.state));
    const without = H.device("A", p, a.sync.keys());
    without.store.state = JSON.parse(JSON.stringify(a.store.state));
    delete without.store.state.revokedHere;
    const r1 = await without.sync.sync().then(() => "accepted", (e) => `${errName(e)} ${JSON.stringify(e.revocationReapplied)}`);
    const phoneIn = !!(await wrapFor(p, "phone", phone.identity));
    const r2 = await withList.sync.sync().then(() => "accepted", (e) => `${errName(e)} ${JSON.stringify(e.revocationReapplied)}`);
    console.log("  state without revokedHere:", r1, "(phone wrap:", phoneIn, ") | with it:", r2, "| phone wrap now:", !!(await wrapFor(p, "phone", phone.identity)));
    expect(r1).not.toBe("accepted");
  });
});
