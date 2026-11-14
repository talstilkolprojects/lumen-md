#!/usr/bin/env node
/**
 * Desktop release signing helpers (plan 11.5), used by .github/workflows/release.yml.
 *
 *   node scripts/tauri-signing.mjs updater-config
 *       fill src-tauri/tauri.conf.json's updater from LUMEN_UPDATER_PUBKEY /
 *       LUMEN_UPDATER_ENDPOINT / TAURI_SIGNING_PRIVATE_KEY (inert without them)
 *   node scripts/tauri-signing.mjs windows-thumbprint <SHA1>
 *       sign the Windows bundle with the imported certificate
 *   node scripts/tauri-signing.mjs latest-json --tag vX --repo o/r --sigs DIR --out latest.json
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { latestJson, withUpdater, withWindowsThumbprint } from "./lib/tauriSigning.mjs";

const CONF = path.join(process.cwd(), "src-tauri", "tauri.conf.json");
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : undefined;
};
const read = () => JSON.parse(readFileSync(CONF, "utf8"));
const write = (c) => writeFileSync(CONF, JSON.stringify(c, null, 2) + "\n");

if (cmd === "updater-config") {
  const { conf, updater } = withUpdater(read(), process.env);
  write(conf);
  console.log(updater ? "updater: on (signed update artifacts)" : "updater: off (no signing key / public key — plan 15.7)");
} else if (cmd === "windows-thumbprint") {
  write(withWindowsThumbprint(read(), rest[0]));
  console.log("windows: signing with the imported certificate");
} else if (cmd === "latest-json") {
  const dir = opt("--sigs");
  const sigs = readdirSync(dir).filter((f) => f.endsWith(".sig")).map((name) => ({ name, signature: readFileSync(path.join(dir, name), "utf8") }));
  const out = latestJson({ tag: opt("--tag"), repo: opt("--repo"), sigs });
  if (!Object.keys(out.platforms).length) {
    console.error("no platform signatures found");
    process.exit(1);
  }
  writeFileSync(opt("--out") ?? "latest.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`latest.json: ${Object.keys(out.platforms).join(", ")}`);
} else {
  console.error("usage: tauri-signing.mjs updater-config | windows-thumbprint <SHA1> | latest-json --tag --repo --sigs --out");
  process.exit(2);
}
