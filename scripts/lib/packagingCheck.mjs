/**
 * Offline checks of the package manifests (plan W1.24), before Tal submits
 * them anywhere:
 * - winget: the vendored official JSON schemas (scripts/vendor/winget-schemas,
 *   MIT) and the three files agreeing with each other;
 * - Homebrew: the cask's stanzas and brew's `desc` rules, and `ruby -c` when
 *   Ruby is installed;
 * - Flathub: flatpak-builder's required keys, sandbox permissions Flathub
 *   rejects, the metainfo's required elements and release;
 * - AUR: `bash -n` on the PKGBUILD when bash is installed, and .SRCINFO
 *   agreeing with it.
 * Each returns a list of problems (empty = fine).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./jsonSchemaLite.mjs";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "winget-schemas");
const HEX = /^[0-9a-f]{64}$/;

function withTool(bin, args, text, ext) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error) return null; // not installed: the structural checks still ran
  const dir = mkdtempSync(join(tmpdir(), "lumen-pkg-"));
  try {
    const f = join(dir, `file${ext}`);
    writeFileSync(f, text);
    const r = spawnSync(bin, [...args, f], { encoding: "utf8" });
    return r.status === 0 ? [] : [`${bin} ${args.join(" ")}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkWinget(objects, version = "1.6.0") {
  const out = [];
  for (const kind of ["version", "installer", "defaultLocale"]) {
    const schema = JSON.parse(readFileSync(join(SCHEMAS, version, `manifest.${kind}.${version}.json`), "utf8"));
    for (const p of validate(schema, objects[kind])) out.push(`winget ${kind}: ${p}`);
  }
  const ids = new Set(Object.values(objects).map((o) => `${o.PackageIdentifier}@${o.PackageVersion}`));
  if (ids.size !== 1) out.push(`winget: the files disagree on identifier/version: ${[...ids].join(", ")}`);
  if (objects.version.DefaultLocale !== objects.defaultLocale.PackageLocale) out.push("winget: DefaultLocale has no matching defaultLocale file");
  return out;
}

export function checkCask(text) {
  const out = [];
  for (const stanza of ["version", "sha256", "url", "name", "desc", "homepage", "app"]) if (!new RegExp(`^  ${stanza} `, "m").test(text)) out.push(`cask: missing ${stanza}`);
  if (!/^cask "[a-z0-9-]+" do$/m.test(text) || !/^end$/m.test(text)) out.push("cask: not a cask block");
  const shaBlock = /^  sha256 [\s\S]*?(?=\n\s*\n)/m.exec(text)?.[0] ?? "";
  const hashes = [...shaBlock.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (!hashes.length) out.push("cask: sha256 has no hash");
  for (const h of hashes) if (!HEX.test(h)) out.push(`cask: bad sha256 ${h}`);
  if (/url "http:/.test(text)) out.push("cask: url must be https");
  const desc = /^  desc "([^"]*)"/m.exec(text)?.[1] ?? "";
  if (desc.length > 80) out.push("cask: desc is longer than 80 characters");
  if (/^(a|an|the)\s/i.test(desc)) out.push("cask: desc starts with an article");
  if (/\.$/.test(desc)) out.push("cask: desc ends with a period");
  const name = /^  name "([^"]*)"/m.exec(text)?.[1];
  if (name && desc.toLowerCase().startsWith(name.toLowerCase())) out.push("cask: desc starts with the app's name");
  // brew style orders the stanzas: arch/version/sha256, url, name, desc, homepage, livecheck, depends_on, app, zap.
  const order = ["version", "sha256", "url", "name", "desc", "homepage", "livecheck", "depends_on", "app", "zap"].map((s) => text.search(new RegExp(`^  ${s}\\b`, "m"))).filter((i) => i >= 0);
  if (order.some((x, i) => i && x < order[i - 1])) out.push("cask: stanzas are out of brew style's order");
  out.push(...(withTool("ruby", ["-c"], text, ".rb") ?? []));
  return out;
}

export function checkFlatpak(manifest, metainfoXml) {
  const out = [];
  for (const k of ["id", "runtime", "runtime-version", "sdk", "command", "modules"]) if (!(k in manifest)) out.push(`flatpak: missing ${k}`);
  if (!/^[A-Za-z][\w-]*(\.[A-Za-z_][\w-]*){2,}$/.test(manifest.id ?? "")) out.push(`flatpak: id is not reverse-DNS: ${manifest.id}`);
  const banned = ["--filesystem=host", "--filesystem=home", "--device=all", "--socket=session-bus", "--socket=system-bus"];
  for (const a of manifest["finish-args"] ?? []) if (banned.includes(a)) out.push(`flatpak: Flathub rejects ${a} without a reason`);
  for (const m of manifest.modules ?? []) {
    if (!m.name || !m.buildsystem) out.push("flatpak: a module needs name and buildsystem");
    for (const s of m.sources ?? []) {
      if (s.url && !/^https:\/\//.test(s.url)) out.push(`flatpak: source url must be https: ${s.url}`);
      if (s.url && !HEX.test(s.sha256 ?? "")) out.push(`flatpak: source ${s.url} needs a sha256`);
    }
  }
  const has = (tag) => new RegExp(`<${tag}[\\s>]`).test(metainfoXml);
  for (const tag of ["id", "name", "summary", "metadata_license", "project_license", "description", "launchable", "content_rating", "releases", "release", "developer"]) if (!has(tag)) out.push(`metainfo: missing <${tag}>`);
  if (/<id>([^<]*)<\/id>/.exec(metainfoXml)?.[1] !== manifest.id) out.push("metainfo: <id> differs from the manifest's id");
  if (!/<launchable type="desktop-id">([^<]*)<\/launchable>/.test(metainfoXml) || !metainfoXml.includes(`${manifest.id}.desktop`)) out.push("metainfo: launchable is not <id>.desktop");
  // Well-formed enough: every opened element is closed, in order.
  const stack = [];
  for (const t of metainfoXml.replace(/<\?[^>]*\?>|<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([\w:-]+)[^>]*?(\/?)>/g)) {
    if (t[3]) continue;
    if (!t[1]) stack.push(t[2]);
    else if (stack.pop() !== t[2]) {
      out.push(`metainfo: </${t[2]}> closes the wrong element`);
      break;
    }
  }
  if (stack.length) out.push(`metainfo: <${stack.at(-1)}> is not closed`);
  return out;
}

const field = (text, k) => [...text.matchAll(new RegExp(`^\\t?${k} = (.*)$`, "gm"))].map((m) => m[1]);
const shVar = (text, k) => /=\((.*)\)$/.exec(new RegExp(`^${k}=(\\(.*\\)|.*)$`, "m").exec(text)?.[0] ?? "")?.[1] ?? new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1];

export function checkAur(pkgbuild, srcinfo) {
  const out = [];
  for (const k of ["pkgname", "pkgver", "pkgrel", "pkgdesc", "arch", "url", "license", "source_x86_64", "sha256sums_x86_64"]) if (!new RegExp(`^${k}=`, "m").test(pkgbuild)) out.push(`PKGBUILD: missing ${k}`);
  if (!/^package\(\) \{/m.test(pkgbuild)) out.push("PKGBUILD: missing package()");
  const strip = (v) => String(v ?? "").replace(/^['"(]+|['")]+$/g, "");
  if (strip(shVar(pkgbuild, "pkgver")) !== field(srcinfo, "pkgver")[0]) out.push(".SRCINFO: pkgver differs from the PKGBUILD");
  if (strip(shVar(pkgbuild, "pkgname")) !== field(srcinfo, "pkgname")[0]) out.push(".SRCINFO: pkgname differs from the PKGBUILD");
  for (const k of ["sha256sums", "sha256sums_x86_64"]) {
    const a = strip(shVar(pkgbuild, k));
    const b = field(srcinfo, k)[0];
    if (!HEX.test(a)) out.push(`PKGBUILD: ${k} is not a sha256`);
    if (a !== b) out.push(`.SRCINFO: ${k} differs from the PKGBUILD`);
  }
  if (strip(shVar(pkgbuild, "pkgver")).includes("-")) out.push("PKGBUILD: pkgver must not contain a hyphen");
  out.push(...(withTool("bash", ["-n"], pkgbuild, ".sh") ?? []));
  return out;
}
