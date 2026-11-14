#!/usr/bin/env node
/**
 * Test vectors for the update manifest's signature (W11.S2 / W11.S3):
 * latest.json signed by the release's own signer (scripts/lib/releaseRun.mjs
 * `signManifest`, the same path `npm run release` takes with a throwaway
 * key), plus the tampered cases. The Rust side checks the same file with the
 * real minisign check (src-tauri/src/updates.rs
 * `release_signed_manifests_verify_with_minisign`), so a signature the
 * release makes is one the app accepts, and nothing else is.
 *
 * The key is made for this run and thrown away: only its public half is in
 * the file. These are synthetic test vectors, not a real release.
 *
 *   node scripts/supply-chain/manifest-sig-vectors.mjs [out.json]
 *     (default: src-tauri/tests/fixtures/manifest-sig-vectors.json)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeys } from "./minisign.mjs";
import { signManifest, testUpdaterKey } from "../lib/releaseRun.mjs";

const manifest = (version) =>
  JSON.stringify(
    {
      version,
      notes: "Synthetic test vector (W11.S2) — ניסוי",
      pub_date: "2026-11-15T00:00:00.000Z",
      platforms: {
        "darwin-aarch64": { signature: "dW50cnVzdGVk", url: `https://github.com/talstilkol/lumen-md/releases/download/v${version}/Lumen_${version}_aarch64.app.tar.gz` },
      },
    },
    null,
    2,
  ) + "\n";

export function makeVectors() {
  const a = testUpdaterKey(() => generateKeys());
  const b = testUpdaterKey(() => generateKeys());
  const now = manifest("0.3.0");
  const old = manifest("0.1.0");
  const sigNow = signManifest(Buffer.from(now), a, { timestamp: 1763164800 });
  const sigOld = signManifest(Buffer.from(old), a, { timestamp: 1763164800 });
  const sigOtherKey = signManifest(Buffer.from(now), b, { timestamp: 1763164800 });
  const flipped = now.replace('"0.3.0"', '"0.3.1"');
  return {
    $comment: "Synthetic vectors made by scripts/supply-chain/manifest-sig-vectors.mjs with a throwaway key (only its public half is here). Checked by src/__tests__/updaterManifestSig.test.ts (Node) and src-tauri/src/updates.rs (Rust, minisign-verify).",
    pubkey: a.pubkey,
    cases: [
      { name: "signed by the release signer", manifest: now, sig: sigNow, expect: "ok" },
      { name: "an older manifest, validly signed (the version rule refuses it later)", manifest: old, sig: sigOld, expect: "ok" },
      { name: "no latest.json.sig", manifest: now, sig: null, expect: "unsigned" },
      { name: "empty latest.json.sig", manifest: now, sig: "", expect: "unsigned" },
      { name: "one byte of the manifest changed", manifest: flipped, sig: sigNow, expect: "bad-signature" },
      { name: "the old manifest's signature on the new manifest", manifest: now, sig: sigOld, expect: "bad-signature" },
      { name: "signed by another key", manifest: now, sig: sigOtherKey, expect: "bad-signature" },
      { name: "signature is not base64", manifest: now, sig: "%%% not base64 %%%", expect: "malformed" },
      { name: "signature decodes to something that is not minisign", manifest: now, sig: Buffer.from("untrusted comment: x\nnot a signature\n").toString("base64"), expect: "bad-signature" },
      { name: "signature with one character changed", manifest: now, sig: corrupt(sigNow), expect: "bad-signature" },
      { name: "no updater key in the build", manifest: now, sig: sigNow, pubkey: "", expect: "malformed" },
    ],
  };
}

/** Change one base64 character of the signature line inside the .sig (still valid base64 and UTF-8). */
function corrupt(sigB64) {
  const text = Buffer.from(sigB64, "base64").toString("utf8").split("\n");
  const line = text[1];
  const i = 20;
  text[1] = line.slice(0, i) + (line[i] === "A" ? "B" : "A") + line.slice(i + 1);
  return Buffer.from(text.join("\n")).toString("base64");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? "src-tauri/tests/fixtures/manifest-sig-vectors.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(makeVectors(), null, 2) + "\n");
  console.log(`wrote ${out}`);
}
