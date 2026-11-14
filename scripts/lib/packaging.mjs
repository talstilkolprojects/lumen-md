/**
 * Store and package-manager manifests from the release's own metadata
 * (plan W1.24): a Homebrew cask, winget manifests, a Flathub manifest with
 * its AppStream metainfo, and an AUR PKGBUILD with .SRCINFO. Every hash
 * comes from the release's SHA256SUMS (scripts/release.mjs build): a
 * format whose artifacts are not in it is skipped, never filled with a
 * placeholder. Pure functions; scripts/release.mjs `packages` writes them,
 * scripts/lib/packagingCheck.mjs validates them. Nothing is submitted.
 */

/** Tauri's default bundle file names (v2), per platform. */
export const ARTIFACTS = {
  macArm: (v) => `Lumen_${v}_aarch64.dmg`,
  macIntel: (v) => `Lumen_${v}_x64.dmg`,
  winExe: (v) => `Lumen_${v}_x64-setup.exe`,
  winMsi: (v) => `Lumen_${v}_x64_en-US.msi`,
  deb: (v) => `Lumen_${v}_amd64.deb`,
};

/** "hash  file" lines → Map(file → lower-case hex). */
export function parseSums(text) {
  const m = new Map();
  for (const line of String(text).split("\n")) {
    const x = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (x) m.set(x[2], x[1].toLowerCase());
  }
  return m;
}

/** Brew's rules for `desc`: no leading article, no trailing period, at most 80 characters. */
export function caskDesc(text) {
  let d = String(text).trim().replace(/\.$/, "").replace(/^(a|an|the)\s+/i, "");
  d = d.charAt(0).toUpperCase() + d.slice(1);
  return d.length > 80 ? d.slice(0, 80).replace(/\s+\S*$/, "") : d;
}

/**
 * The metadata every format shares, from package.json, src-tauri/tauri.conf.json,
 * the version and the GitHub repo (owner/name). `licenseSha256`: the LICENSE file's hash (AUR).
 */
export function packagingMeta({ pkg, tauri, version, repo, licenseSha256 = null }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`a GitHub repo (owner/name) is needed, got ${repo}`);
  const [owner, name] = repo.split("/");
  const v = String(version).replace(/^v/, "");
  const site = `https://github.com/${repo}`;
  return {
    version: v,
    tag: `v${v}`,
    name: tauri.productName,
    binary: "lumen",
    bundleId: tauri.identifier,
    // Flathub wants an id under a domain or code host the developer controls.
    flatpakId: `io.github.${owner.toLowerCase()}.${tauri.productName}`,
    wingetId: `${owner.charAt(0).toUpperCase()}${owner.slice(1)}.${tauri.productName}`,
    aurName: `${name}-bin`,
    caskName: name,
    owner,
    summary: tauri.bundle.shortDescription,
    description: tauri.bundle.longDescription,
    license: pkg.license,
    homepage: site,
    licenseUrl: `${site}/blob/${`v${v}`}/LICENSE`,
    download: (file) => `${site}/releases/download/v${v}/${file}`,
    rawLicense: `https://raw.githubusercontent.com/${repo}/v${v}/LICENSE`,
    licenseSha256,
  };
}

function need(sums, files) {
  const missing = files.filter((f) => !sums.has(f));
  return missing.length ? `not in SHA256SUMS: ${missing.join(", ")}` : null;
}

/* ── Homebrew ─────────────────────────────────────────────────────────── */

export function homebrewCask(meta, sums) {
  const arm = ARTIFACTS.macArm(meta.version);
  const intel = ARTIFACTS.macIntel(meta.version);
  const both = sums.has(arm) && sums.has(intel);
  const one = sums.has(arm) ? arm : sums.has(intel) ? intel : null;
  if (!one) return { skipped: need(sums, [arm, intel]) };
  const lines = [`cask "${meta.caskName}" do`];
  if (both) lines.push(`  arch arm: "aarch64", intel: "x64"`, "");
  lines.push(`  version "${meta.version}"`);
  if (both) lines.push(`  sha256 arm:   "${sums.get(arm)}",`, `         intel: "${sums.get(intel)}"`, "");
  else lines.push(`  sha256 "${sums.get(one)}"`, "");
  const file = both ? `Lumen_#{version}_#{arch}.dmg` : one.replace(meta.version, "#{version}");
  lines.push(
    `  url "${meta.homepage}/releases/download/v#{version}/${file}"`,
    `  name "${meta.name}"`,
    `  desc "${caskDesc(meta.summary)}"`,
    `  homepage "${meta.homepage}"`,
    "",
    "  livecheck do",
    "    url :url",
    "    strategy :github_latest",
    "  end",
    "",
    // Tauri 2 needs macOS 10.15.
    `  depends_on macos: ">= :catalina"`,
    "",
    `  app "${meta.name}.app"`,
    "",
    "  zap trash: [",
    ...["Application Support", "Caches", "WebKit"].map((d) => `    "~/Library/${d}/${meta.bundleId}",`),
    `    "~/Library/Preferences/${meta.bundleId}.plist",`,
    `    "~/Library/Saved Application State/${meta.bundleId}.savedState",`,
    "  ]",
    "end",
    "",
  );
  return { files: { [`homebrew/${meta.caskName}.rb`]: lines.join("\n") }, note: both ? null : `one architecture only (${one})` };
}

/* ── winget ───────────────────────────────────────────────────────────── */

export const WINGET_MANIFEST_VERSION = "1.6.0";

export function wingetObjects(meta, sums) {
  const installers = [];
  const exe = ARTIFACTS.winExe(meta.version);
  const msi = ARTIFACTS.winMsi(meta.version);
  if (sums.has(exe)) installers.push({ Architecture: "x64", InstallerType: "nullsoft", Scope: "user", InstallerUrl: meta.download(exe), InstallerSha256: sums.get(exe).toUpperCase() });
  if (sums.has(msi)) installers.push({ Architecture: "x64", InstallerType: "wix", Scope: "machine", InstallerUrl: meta.download(msi), InstallerSha256: sums.get(msi).toUpperCase() });
  if (!installers.length) return { skipped: need(sums, [exe, msi]) };
  const base = { PackageIdentifier: meta.wingetId, PackageVersion: meta.version };
  const mv = { ManifestVersion: WINGET_MANIFEST_VERSION };
  return {
    version: { ...base, DefaultLocale: "en-US", ManifestType: "version", ...mv },
    installer: { ...base, MinimumOSVersion: "10.0.17763.0", Installers: installers, ManifestType: "installer", ...mv },
    defaultLocale: {
      ...base,
      PackageLocale: "en-US",
      Publisher: meta.owner,
      PublisherUrl: `https://github.com/${meta.owner}`,
      PackageName: meta.name,
      PackageUrl: meta.homepage,
      License: meta.license,
      LicenseUrl: meta.licenseUrl,
      ShortDescription: meta.summary,
      Description: meta.description,
      Moniker: meta.caskName,
      Tags: ["markdown", "editor", "notes", "hebrew", "rtl", "local-first"],
      ReleaseNotesUrl: `${meta.homepage}/releases/tag/${meta.tag}`,
      ManifestType: "defaultLocale",
      ...mv,
    },
  };
}

/** YAML for winget: every string double-quoted (JSON strings are valid YAML), keys in order. */
export function toYaml(value, indent = "") {
  const scalar = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));
  const lines = [];
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      lines.push(`${indent}${k}:`);
      for (const item of v) {
        if (item && typeof item === "object") {
          const inner = toYaml(item, `${indent}  `).split("\n");
          lines.push(`${indent}- ${inner[0].trimStart()}`, ...inner.slice(1));
        } else lines.push(`${indent}- ${scalar(item)}`);
      }
    } else if (v && typeof v === "object") lines.push(`${indent}${k}:`, toYaml(v, `${indent}  `));
    else lines.push(`${indent}${k}: ${scalar(v)}`);
  }
  return lines.join("\n");
}

export function wingetManifests(meta, sums) {
  const o = wingetObjects(meta, sums);
  if (o.skipped) return o;
  const dir = `winget/manifests/${meta.wingetId[0].toLowerCase()}/${meta.wingetId.replace(".", "/")}/${meta.version}`;
  const file = (kind, suffix) => {
    const schema = `https://aka.ms/winget-manifest.${kind}.${WINGET_MANIFEST_VERSION}.schema.json`;
    return `# Created by node scripts/release.mjs packages (plan W1.24)\n# yaml-language-server: $schema=${schema}\n\n${toYaml(o[kind])}\n`;
  };
  return {
    objects: o,
    files: {
      [`${dir}/${meta.wingetId}.yaml`]: file("version"),
      [`${dir}/${meta.wingetId}.installer.yaml`]: file("installer"),
      [`${dir}/${meta.wingetId}.locale.en-US.yaml`]: file("defaultLocale"),
    },
  };
}

/* ── Flathub ──────────────────────────────────────────────────────────── */

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function metainfo(meta, { date = new Date() } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Created by node scripts/release.mjs packages (plan W1.24) -->
<component type="desktop-application">
  <id>${meta.flatpakId}</id>
  <name>${xml(meta.name)}</name>
  <summary>${xml(caskDesc(meta.summary))}</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>${xml(meta.license)}</project_license>
  <developer id="io.github.${xml(meta.owner.toLowerCase())}">
    <name>${xml(meta.owner)}</name>
  </developer>
  <description>
    <p>${xml(meta.description)}</p>
  </description>
  <launchable type="desktop-id">${meta.flatpakId}.desktop</launchable>
  <url type="homepage">${xml(meta.homepage)}</url>
  <url type="bugtracker">${xml(meta.homepage)}/issues</url>
  <content_rating type="oars-1.1"/>
  <releases>
    <release version="${xml(meta.version)}" date="${date.toISOString().slice(0, 10)}">
      <url type="details">${xml(meta.homepage)}/releases/tag/${meta.tag}</url>
    </release>
  </releases>
</component>
`;
}

/**
 * The flatpak-builder manifest (JSON, which flatpak-builder reads like YAML):
 * the release's .deb, unpacked into /app, as Tauri's Flatpak guide does.
 */
export function flatpakManifest(meta, sums, { date } = {}) {
  const deb = ARTIFACTS.deb(meta.version);
  if (!sums.has(deb)) return { skipped: need(sums, [deb]) };
  const id = meta.flatpakId;
  const manifest = {
    id,
    runtime: "org.gnome.Platform",
    "runtime-version": "47",
    sdk: "org.gnome.Sdk",
    command: meta.binary,
    "finish-args": [
      "--socket=wayland",
      "--socket=fallback-x11",
      "--share=ipc",
      "--device=dri",
      // Sync, cloud AI when the user allows it, model downloads.
      "--share=network",
      // The default vault folder (Documents); other folders go through the file-chooser portal.
      "--filesystem=xdg-documents",
    ],
    modules: [
      {
        name: meta.binary,
        buildsystem: "simple",
        sources: [
          { type: "file", url: meta.download(deb), sha256: sums.get(deb), "dest-filename": `${meta.binary}.deb`, "only-arches": ["x86_64"] },
          { type: "file", path: `${id}.metainfo.xml` },
        ],
        "build-commands": [
          `ar -x ${meta.binary}.deb`,
          "tar -xf data.tar.gz",
          `install -Dm755 usr/bin/${meta.binary} /app/bin/${meta.binary}`,
          `install -Dm644 usr/share/applications/${meta.name}.desktop /app/share/applications/${id}.desktop`,
          `desktop-file-edit --set-icon=${id} /app/share/applications/${id}.desktop`,
          `for s in 32x32 128x128 256x256@2; do install -Dm644 usr/share/icons/hicolor/$s/apps/${meta.binary}.png /app/share/icons/hicolor/$s/apps/${id}.png; done`,
          `install -Dm644 ${id}.metainfo.xml /app/share/metainfo/${id}.metainfo.xml`,
        ],
      },
    ],
  };
  return {
    manifest,
    files: {
      [`flatpak/${id}.json`]: JSON.stringify(manifest, null, 2) + "\n",
      [`flatpak/${id}.metainfo.xml`]: metainfo(meta, { date }),
    },
  };
}

/* ── AUR ──────────────────────────────────────────────────────────────── */

export function aurPackage(meta, sums) {
  const deb = ARTIFACTS.deb(meta.version);
  if (!sums.has(deb)) return { skipped: need(sums, [deb]) };
  if (!meta.licenseSha256) return { skipped: "the LICENSE file's sha256 is needed (Arch packages install the licence)" };
  const desc = caskDesc(meta.summary);
  // pacman versions cannot hold a hyphen (0.2.0-beta.1 → 0.2.0_beta.1); the URLs keep the real one in _ver.
  const pkgver = meta.version.replace(/-/g, "_");
  const url = (u) => u.replaceAll(`v${meta.version}`, "v${_ver}").replaceAll(meta.version, "${_ver}");
  const pkgbuild = `# Created by node scripts/release.mjs packages (plan W1.24)
# Maintainer: ${meta.owner} <https://github.com/${meta.owner}>
pkgname=${meta.aurName}
_ver=${meta.version}
pkgver=${pkgver}
pkgrel=1
pkgdesc=${JSON.stringify(desc)}
arch=('x86_64')
url=${JSON.stringify(meta.homepage)}
license=('${meta.license}')
depends=('webkit2gtk-4.1' 'gtk3' 'hicolor-icon-theme')
provides=('${meta.binary}')
conflicts=('${meta.binary}')
options=('!strip' '!debug')
source=("LICENSE-\${_ver}::${url(meta.rawLicense)}")
source_x86_64=("${meta.aurName}-\${_ver}-x86_64.deb::${url(meta.download(deb))}")
sha256sums=('${meta.licenseSha256}')
sha256sums_x86_64=('${sums.get(deb)}')

package() {
  bsdtar -xf data.tar.gz -C "\${pkgdir}"
  install -Dm644 "LICENSE-\${_ver}" "\${pkgdir}/usr/share/licenses/\${pkgname}/LICENSE"
}
`;
  const srcinfo = `pkgbase = ${meta.aurName}
\tpkgdesc = ${desc}
\tpkgver = ${pkgver}
\tpkgrel = 1
\turl = ${meta.homepage}
\tarch = x86_64
\tlicense = ${meta.license}
\tdepends = webkit2gtk-4.1
\tdepends = gtk3
\tdepends = hicolor-icon-theme
\tprovides = ${meta.binary}
\tconflicts = ${meta.binary}
\toptions = !strip
\toptions = !debug
\tsource = LICENSE-${meta.version}::${meta.rawLicense}
\tsha256sums = ${meta.licenseSha256}
\tsource_x86_64 = ${meta.aurName}-${meta.version}-x86_64.deb::${meta.download(deb)}
\tsha256sums_x86_64 = ${sums.get(deb)}

pkgname = ${meta.aurName}
`;
  return { files: { [`aur/${meta.aurName}/PKGBUILD`]: pkgbuild, [`aur/${meta.aurName}/.SRCINFO`]: srcinfo } };
}

/** Every format → { files: { path: text }, report: [{ format, status, detail }] }. */
export function allPackages(meta, sums, opts = {}) {
  const files = {};
  const report = [];
  for (const [format, fn] of [
    ["homebrew", homebrewCask],
    ["winget", wingetManifests],
    ["flatpak", flatpakManifest],
    ["aur", aurPackage],
  ]) {
    const r = fn(meta, sums, opts);
    if (r.skipped) report.push({ format, status: "skipped", detail: r.skipped });
    else {
      Object.assign(files, r.files);
      report.push({ format, status: "written", detail: r.note ?? Object.keys(r.files).join(", ") });
    }
  }
  return { files, report };
}
