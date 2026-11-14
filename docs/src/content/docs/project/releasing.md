---
title: Releasing a version
description: One local command builds, signs and checks a release, and with --publish puts it on GitHub Releases with signed desktop updates. No GitHub Actions.
---

A release is one command on the release owner's computer. GitHub Actions
are not needed.

```bash
npm run release -- 0.2.0-beta.1 --dry-run     # build, sign and check everything; publish nothing
npm run release -- 0.2.0-beta.1 --publish     # the owner: commit, tag, build, sign, push, GitHub release
```

A dry run puts the tree back when it finishes: the version, `CHANGELOG.md` and
`src-tauri/tauri.conf.json` return to what they were. It leaves `release/`
with every asset, plus `release/DRY-RUN.md`, which lists the assets and the
exact commands `--publish` would run.

## What the command does

1. **Preflight.** It lists everything that is missing (a key, a tool, the
   release notes, a clean tree, the `main` branch, `gh auth`), each with the
   command that fixes it. A dry run needs no key. A publish needs every one.
2. **Version and changelog.** It bumps the version in `package.json`,
   `package-lock.json`, `tauri.conf.json`, `Cargo.toml` and the iOS project.
   It writes the `CHANGELOG.md` section from the pull requests merged since
   the last tag: one line per PR, sorted by the type in its title (Added,
   Fixed, Performance, …), with a link to the PR. PR titles come from the
   GitHub API; offline (`--offline`) it uses the merge commits.
3. **Commit and tag** (`--publish` only): `chore(release): X` and `vX`.
4. **The updater.** The committed `tauri.conf.json` carries the placeholder
   `${LUMEN_UPDATER_PUBKEY}`. The release fills in the public key and the
   endpoint on GitHub Releases (stable: `releases/latest/download/latest.json`;
   a beta: the rolling `beta-channel` release). It also turns on signed update
   bundles. The build stops if the key is empty, is still the placeholder or
   is not a minisign key. Afterwards the file goes back to the placeholder.
5. **A reproducible web build.** `repro-check` builds twice with
   `SOURCE_DATE_EPOCH` and compares every file, then the bundle budget and the
   source-map check run. `lumen-web-vX.tgz` is the same bytes on every machine:
   the files are sorted, the owner and mode are fixed, and the gzip header has
   no time.
6. **Desktop.** `tauri build` runs with `TAURI_SIGNING_PRIVATE_KEY`. The macOS
   update bundle gets its version and architecture in its name.
   `latest.json` is built from the `.sig` files. Every signature is checked
   against the updater key, and the same check must refuse a copy with one
   byte changed.
7. **SBOM.** `sbom.cdx.json` (CycloneDX 1.5) lists every package in
   `package-lock.json` and every crate in `Cargo.lock`. It is built offline.
8. **Release notes.** Hebrew first, then English, from
   `release-notes/<version>.he.md` and `release-notes/<version>.en.md`
   (written by hand, a few lines each), then the full change list and how to
   verify the download.
9. **Checksums.** `SHA256SUMS` lists every asset. It is signed with minisign
   (`SHA256SUMS.minisig`), and so is the SBOM. The whole folder is then
   verified, and a changed `SHA256SUMS` must fail.
10. **Publish** (`--publish` only): `git push origin HEAD vX`, then
    `gh release create`. A beta is a pre-release and is never "latest", so
    stable users never get it. Then `latest.json` is uploaded to the
    `beta-channel` release.

## Options

| Option | What it does |
|---|---|
| `--dry-run` | the default: nothing is committed, tagged or published |
| `--publish` | the real release (the owner) |
| `--fake-build` | dry run only: stand-in bundles where `node_modules`, Rust or the Tauri CLI are missing; every later step still runs. A publish refuses it. |
| `--no-repro` | one web build instead of two |
| `--no-desktop` | web, SBOM and checksums only |
| `--skip-checks` | no typecheck and no tests before the build |
| `--offline` | PR titles from git, not from the GitHub API |

## Keys (made once, kept by the owner)

| Key | Made with | Used through |
|---|---|---|
| Updater signing key | `npx tauri signer generate -w ~/.tauri/lumen-updater.key` | `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) |
| Updater public key | written next to it (`.key.pub`) | commit it as `security/updater-key.pub`, or set `LUMEN_UPDATER_PUBKEY` |
| Release key (checksums, SBOM) | `node scripts/supply-chain/keys.mjs` | `LUMEN_RELEASE_KEY` (+ `LUMEN_RELEASE_PASSPHRASE`); commit `security/release-key.pub` |

When a key is missing, a dry run signs with throwaway test keys and says so.
Their public keys have `TEST` in their comment line, and a publish refuses
them.

## Checking a release (anyone)

```bash
gh release download v0.2.0-beta.1 --repo talstilkol/lumen-md --dir lumen
cd lumen && minisign -Vm SHA256SUMS -p release-key.pub && sha256sum -c SHA256SUMS
# or, without minisign:
node scripts/supply-chain/verify-release.mjs lumen --pub security/release-key.pub
```

## Limits

- One `--publish` run uploads the bundles of the machine it runs on: the
  macOS bundles from a Mac. Bundles for Linux and Windows from other
  machines are not added to the same release yet. Until they are, publish
  from the Mac (that gives at least the `.dmg`, the update bundle, its
  signature, the web `.tgz` and the SBOM).
- Rolling back is `node scripts/release.mjs rollback <bad> --to <good>` (see
  `RELEASE.md`).
