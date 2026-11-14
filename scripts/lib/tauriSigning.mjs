/**
 * Desktop release signing (plan 11.5), shared by scripts/tauri-signing.mjs
 * and its tests. Every secret is optional: without one, the matching step
 * is skipped and the build still succeeds (plan 15.7 supplies them).
 */

/** tauri.conf.json with the updater filled in from the environment, or left inert. */
export function withUpdater(conf, env) {
  const out = structuredClone(conf);
  const key = (env.LUMEN_UPDATER_PUBKEY ?? "").trim();
  const endpoint = (env.LUMEN_UPDATER_ENDPOINT ?? "").trim();
  const canSign = !!(env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim();
  out.plugins ??= {};
  out.plugins.updater = { ...(out.plugins.updater ?? {}), pubkey: key, endpoints: key && endpoint ? [endpoint] : [], requireSignedVersion: true };
  out.bundle ??= {};
  // Update artifacts need the private key; without it, tauri build would fail.
  out.bundle.createUpdaterArtifacts = canSign && !!key;
  return { conf: out, updater: out.bundle.createUpdaterArtifacts };
}

/** tauri.conf.json with Windows signing by certificate thumbprint. */
export function withWindowsThumbprint(conf, thumbprint) {
  if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint ?? "")) throw new Error("not a certificate thumbprint (40 hex characters)");
  const out = structuredClone(conf);
  out.bundle ??= {};
  out.bundle.windows = { ...(out.bundle.windows ?? {}), certificateThumbprint: thumbprint.toUpperCase(), digestAlgorithm: "sha256", timestampUrl: "http://timestamp.digicert.com" };
  return out;
}

/** The updater platform key for a bundle file name. */
export function platformOf(file) {
  const f = file.toLowerCase();
  const arch = /aarch64|arm64/.test(f) ? "aarch64" : /i686|x86(?!_64)/.test(f) ? "i686" : "x86_64";
  if (f.endsWith(".app.tar.gz.sig")) return `darwin-${arch}`;
  if (f.endsWith(".appimage.sig") || f.endsWith(".appimage.tar.gz.sig")) return `linux-${arch}`;
  if (f.endsWith(".msi.sig") || f.endsWith(".exe.sig") || f.endsWith(".nsis.zip.sig") || f.endsWith(".msi.zip.sig")) return `windows-${arch}`;
  return null;
}

/** latest.json for the release, from its .sig files ({ name, signature }). */
export function latestJson({ tag, repo, sigs, notes = "", date = new Date() }) {
  const platforms = {};
  for (const { name, signature } of sigs) {
    const p = platformOf(name);
    if (!p) continue;
    // NSIS (.exe) is preferred over MSI for updates, as tauri does.
    if (platforms[p] && p.startsWith("windows") && !name.toLowerCase().includes(".exe")) continue;
    platforms[p] = { signature: signature.trim(), url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name.replace(/\.sig$/, ""))}` };
  }
  return { version: tag.replace(/^v/, ""), notes, pub_date: date.toISOString(), platforms };
}
