/**
 * A local, offline stand-in for Sigstore's public services (plan W7.22,
 * tests only): a Fulcio-like CA that issues a 10-minute certificate for an
 * email and an OIDC issuer, a CT log that embeds an SCT, and a Rekor-like log
 * that returns an entry with an inclusion promise (SET) and a one-leaf
 * inclusion proof with a signed checkpoint. It writes the same
 * trusted_root.json and bundle v0.3 that the real services and cosign v3 do,
 * so verify.mjs (and `cosign verify-blob --trusted-root … --offline`) check them
 * with the real verification code, only against our test roots.
 *
 * Nothing here is used to make a real release: the real certificate comes
 * from fulcio.sigstore.dev after Tal's own login.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

// ── a minimal DER encoder ────────────────────────────────────────────────
const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 0xff]) : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]));
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const int = (buf) => {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
};
const oid = (s) => {
  const p = s.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const bytes = [n & 0x7f];
    for (let v = n >>> 7; v; v >>>= 7) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const octet = (b) => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const bool = () => tlv(0x01, Buffer.from([0xff]));
const time = (d) => {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, Buffer.from(`${s}Z`));
};
const ctx = (n, ...p) => tlv(0xa0 + n, ...p);
const name = (cn) => seq(set(seq(oid("2.5.4.10"), utf8("lumen-md offline test"))), set(seq(oid("2.5.4.3"), utf8(cn))));
const ext = (o, value, critical = false) => seq(oid(o), ...(critical ? [bool()] : []), octet(value));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const spki = (pub) => (typeof pub === "object" && pub.type === "public" ? pub : createPublicKey(pub)).export({ type: "spki", format: "der" });
const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();

function tbs({ serial, issuer, subject, notBefore, notAfter, pub, extensions }) {
  return seq(ctx(0, int(2)), int(serial), ECDSA_SHA256, issuer, seq(time(notBefore), time(notAfter)), subject, spki(pub), ctx(3, seq(...extensions)));
}
const certificate = (tbsDer, issuerKey) => seq(tbsDer, ECDSA_SHA256, bits(sign("sha256", tbsDer, issuerKey)));

const u16 = (n) => Buffer.from([n >> 8, n & 0xff]);
const u24 = (n) => Buffer.from([n >> 16, (n >> 8) & 0xff, n & 0xff]);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/** A signed note's signature line starts with an em dash (golang.org/x/mod/sumdb/note). */
const EM_DASH = String.fromCharCode(0x2014);

/** JSON with sorted keys (Rekor's canonical form for the SET payload). */
const canon = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`);

/**
 * @param {{ now?: Date, keys?: { ca: string, ct: string, rekor: string } }} opts  keys: PEM private keys to reuse
 *   (exportKeys() of an earlier instance), so separate processes sign under one trust root.
 */
export function localSigstore({ now = new Date(), keys = null } = {}) {
  const ec = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
  const load = (pem) => {
    const privateKey = createPrivateKey(pem);
    return { privateKey, publicKey: createPublicKey(privateKey) };
  };
  const ca = keys ? load(keys.ca) : ec();
  const ct = keys ? load(keys.ct) : ec();
  const rekor = keys ? load(keys.rekor) : ec();
  const exportKeys = () => Object.fromEntries(Object.entries({ ca, ct, rekor }).map(([k, v]) => [k, v.privateKey.export({ type: "pkcs8", format: "pem" }).toString()]));
  const start = new Date(now.getTime() - 3600_000);
  const caName = name("lumen-md offline Fulcio stand-in");
  const caCert = certificate(
    tbs({ serial: Buffer.from([1]), issuer: caName, subject: caName, notBefore: start, notAfter: new Date(now.getTime() + 86400_000), pub: ca.publicKey, extensions: [ext("2.5.29.19", seq(bool()), true), ext("2.5.29.15", bits(Buffer.from([0x06]), 1), true)] }),
    ca.privateKey,
  );
  const ctId = sha(spki(ct.publicKey));
  const rekorId = sha(spki(rekor.publicKey));
  const key = (k, id) => ({ baseUrl: "https://example.com/offline", hashAlgorithm: "SHA2_256", publicKey: { rawBytes: spki(k.publicKey).toString("base64"), keyDetails: "PKIX_ECDSA_P256_SHA_256", validFor: { start: start.toISOString() } }, logId: { keyId: id.toString("base64") } });
  const trustedRoot = {
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [key(rekor, rekorId)],
    certificateAuthorities: [{ subject: { organization: "lumen-md offline test", commonName: "lumen-md offline Fulcio stand-in" }, uri: "https://example.com/offline", certChain: { certificates: [{ rawBytes: caCert.toString("base64") }] }, validFor: { start: start.toISOString() } }],
    ctlogs: [key(ct, ctId)],
    timestampAuthorities: [],
  };

  /** Sign `data` as `email` from `issuer`: what `cosign sign-blob --bundle` returns after the browser login. */
  function signBlob(data, { email, issuer, at = new Date() }) {
    const leaf = ec();
    const base = {
      serial: createHash("sha256").update(String(Math.random())).digest().subarray(0, 16),
      issuer: caName,
      subject: seq(),
      notBefore: new Date(at.getTime() - 60_000),
      notAfter: new Date(at.getTime() + 600_000),
      pub: leaf.publicKey,
    };
    const exts = [
      ext("2.5.29.15", bits(Buffer.from([0x80]), 7), true),
      ext("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.3"))),
      ext("2.5.29.17", seq(tlv(0x81, Buffer.from(email, "ascii"))), true),
      ext("1.3.6.1.4.1.57264.1.1", Buffer.from(issuer, "ascii")),
    ];
    // The CT log signs the precertificate (the TBS without the SCT extension), then the SCT goes in.
    const pre = tbs({ ...base, extensions: exts });
    const ts = at.getTime();
    const signed = Buffer.concat([Buffer.from([0, 0]), u64(ts), u16(1), sha(spki(ca.publicKey)), u24(pre.length), pre, u16(0)]);
    const sig = sign("sha256", signed, ct.privateKey);
    const sct = Buffer.concat([Buffer.from([0]), ctId, u64(ts), u16(0), Buffer.from([4, 3]), u16(sig.length), sig]);
    const list = Buffer.concat([u16(sct.length + 2), u16(sct.length), sct]);
    const leafCert = certificate(tbs({ ...base, extensions: [...exts, ext("1.3.6.1.4.1.11129.2.4.2", octet(list))] }), ca.privateKey);

    const digest = createHash("sha256").update(data).digest();
    const signature = sign("sha256", data, leaf.privateKey);
    const pem = `-----BEGIN CERTIFICATE-----\n${leafCert.toString("base64").replace(/.{64}/g, "$&\n").trim()}\n-----END CERTIFICATE-----\n`;
    const body = Buffer.from(canon({ apiVersion: "0.0.1", kind: "hashedrekord", spec: { data: { hash: { algorithm: "sha256", value: digest.toString("hex") } }, signature: { content: signature.toString("base64"), publicKey: { content: Buffer.from(pem).toString("base64") } } } }));
    const integratedTime = Math.floor(at.getTime() / 1000);
    const setPayload = Buffer.from(canon({ body: body.toString("base64"), integratedTime, logIndex: 0, logID: rekorId.toString("hex") }));
    const root = sha(Buffer.from([0]), body); // a one-leaf tree: the root is the leaf hash
    const note = `example.com/offline-rekor\n1\n${root.toString("base64")}\n`;
    const noteSig = Buffer.concat([rekorId.subarray(0, 4), sign("sha256", Buffer.from(note), rekor.privateKey)]);
    return {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: leafCert.toString("base64") },
        tlogEntries: [
          {
            logIndex: "0",
            logId: { keyId: rekorId.toString("base64") },
            kindVersion: { kind: "hashedrekord", version: "0.0.1" },
            integratedTime: String(integratedTime),
            inclusionPromise: { signedEntryTimestamp: sign("sha256", setPayload, rekor.privateKey).toString("base64") },
            inclusionProof: { logIndex: "0", rootHash: root.toString("base64"), treeSize: "1", hashes: [], checkpoint: { envelope: `${note}\n${EM_DASH} example.com/offline-rekor ${noteSig.toString("base64")}\n` } },
            canonicalizedBody: body.toString("base64"),
          },
        ],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: digest.toString("base64") }, signature: signature.toString("base64") },
    };
  }
  return { trustedRoot, signBlob, exportKeys };
}
