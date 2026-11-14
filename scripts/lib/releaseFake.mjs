/**
 * Stand-in build output for `npm run release -- <version> --dry-run --fake-build`
 * (plan W4.5): where node_modules, Rust or the Tauri CLI are missing (a
 * sandbox, a fresh clone), the dry run still exercises every later step —
 * the reproducibility check, the update bundles and their signatures,
 * latest.json, the SBOM, SHA256SUMS and its signature, the notes. Every
 * file says FAKE inside; `--publish` refuses `--fake-build`.
 */
import { macUpdateName, tauriSign } from "./releaseRun.mjs";

const FAKE = "FAKE BUILD — lumen-md release dry run (plan W4.5); not a real program";

/** A deterministic dist/: same version and channel → same bytes. */
export function fakeWeb(version, channel) {
  return [
    { path: "index.html", data: Buffer.from(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>Lumen ${version}</title><!-- ${FAKE} --><script type="module" src="./assets/app.js"></script></html>\n`) },
    { path: "assets/app.js", data: Buffer.from(`// ${FAKE}\nexport const version = ${JSON.stringify(version)}, channel = ${JSON.stringify(channel)};\n`) },
    { path: "manifest.webmanifest", data: Buffer.from(JSON.stringify({ name: "Lumen", short_name: "Lumen", dir: "rtl", lang: "he", start_url: "./" }) + "\n") },
  ];
}

/**
 * The bundles tauri build makes with createUpdaterArtifacts on (Linux, macOS
 * on Apple Silicon, Windows), each update bundle with its .sig, signed with
 * the given (throwaway) key. Returns [{ name, data }].
 */
export function fakeDesktop(version, pem, { passphrase } = {}) {
  const body = (what) => Buffer.from(`${FAKE}\n${what} ${version}\n`);
  const out = [
    { name: `Lumen_${version}_amd64.AppImage`, data: body("Linux AppImage") },
    { name: `Lumen_${version}_amd64.deb`, data: body("Debian package") },
    { name: `Lumen_${version}_aarch64.dmg`, data: body("macOS disk image") },
    { name: macUpdateName("Lumen.app.tar.gz", version, "aarch64"), data: body("macOS update bundle") },
    { name: `Lumen_${version}_x64-setup.exe`, data: body("Windows NSIS installer") },
  ];
  const updatable = (n) => /\.(AppImage|app\.tar\.gz|exe)$/.test(n);
  for (const f of [...out]) if (updatable(f.name)) out.push({ name: `${f.name}.sig`, data: Buffer.from(tauriSign(f.data, pem, f.name, { passphrase })) });
  return out;
}
