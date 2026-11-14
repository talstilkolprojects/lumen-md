/**
 * age over typage (`age-encryption`, by Filippo Valsorda; W10.D13, research
 * R3.5), with the same signatures as ../../age.ts, so the switch is one
 * import. Excluded from tsconfig until 10.M (see ./audited.ts); the C2SP CCTV
 * age testkit and the protocol vectors decide it there.
 */
import * as age from "age-encryption";
import type { AgeIdentityInput, AgeRecipient } from "../../age";

export async function ageEncrypt(plaintext: Uint8Array, recipients: AgeRecipient[]): Promise<Uint8Array> {
  const e = new age.Encrypter();
  for (const r of recipients) {
    if ("x25519" in r) e.addRecipient(r.x25519);
    else {
      if (recipients.length !== 1) throw new Error("age: a passphrase recipient must be the only one");
      e.setPassphrase(r.passphrase);
      if (r.logN !== undefined) e.setScryptWorkFactor(r.logN);
    }
  }
  return e.encrypt(plaintext);
}

export async function ageDecrypt(file: Uint8Array, identities: AgeIdentityInput[]): Promise<Uint8Array> {
  const d = new age.Decrypter();
  for (const i of identities) {
    if ("identity" in i) d.addIdentity(i.identity);
    else d.addPassphrase(i.passphrase);
  }
  return d.decrypt(file, "uint8array");
}
