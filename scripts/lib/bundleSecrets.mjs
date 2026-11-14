/**
 * Plan 3.6.2: the collab server's secrets must never end up in the web
 * bundle. Rules shared by scripts/check-bundle-secrets.mjs and its test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Server-only secrets: their values must not appear in the built app. */
export const SERVER_SECRET_ENV = [
  "COLLAB_TOKEN_SECRET",
  "COLLAB_ACCESS_KEY",
  "COLLAB_TOKEN",
  "LUMEN_COLLAB_TOKEN",
  "LUMEN_COLLAB_TOKEN_SECRET",
  // Removed in 3.6. Any VITE_* value is inlined into the bundle, so a build
  // that still sets this one is flagged.
  "VITE_YJS_WEBSOCKET_TOKEN",
];

/**
 * Markers of server code: a bundle containing them has pulled in the
 * collab server (and with it the place secrets are read).
 */
export const SERVER_CODE_MARKERS = ["COLLAB_TOKEN_SECRET", "createHmac(", "VACUUM INTO"];

const TEXT = /\.(m?js|cjs|css|html|json|map|txt|webmanifest|svg)$/i;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (TEXT.test(name)) yield p;
  }
}

/**
 * Scan `dir`. `env` gives the secret values to look for (CI sets canaries
 * while building). Returns findings: {file, what}.
 */
export function scanForSecrets(dir, env = process.env) {
  const needles = SERVER_SECRET_ENV.map((name) => [name, env[name]])
    .filter(([, v]) => typeof v === "string" && v.length >= 8)
    .map(([name, v]) => ({ what: `value of ${name}`, needle: v }));
  const markers = SERVER_CODE_MARKERS.map((m) => ({ what: `server code marker ${JSON.stringify(m)}`, needle: m }));
  const findings = [];
  for (const file of files(dir)) {
    const text = readFileSync(file, "utf8");
    for (const { what, needle } of [...needles, ...markers]) {
      if (text.includes(needle)) findings.push({ file: relative(dir, file), what });
    }
  }
  return { findings, checkedValues: needles.map((n) => n.what) };
}
