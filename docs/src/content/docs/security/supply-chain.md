---
title: Supply chain
description: Fuzzed decoders, a reproducible build, an SBOM and offline-signed checksums for every release — and how anyone can check them.
---

The [threat model](/security/threat-model/) assumes the code you run is the
code that was released. Four checks make that verifiable.

## 1. The decoders are fuzzed

Everything Lumen reads from a file, a link, the clipboard or a plugin goes
through a decoder: the Markdown pipeline, front matter, BibTeX, JSON and
JSONL (Code Doctor, Insights), URLs (sanitizer, embeds, the CSP check), text
direction — and `.base`, `.excalidraw`, PDF annotations and plugin
manifests as those land.

```bash
npm run fuzz                                    # 1,000,000 inputs per decoder
node scripts/fuzz/run.mjs --target bibtex --runs 50000
node scripts/fuzz/run.mjs --target bibtex --seed 1 --from 4242 --runs 1   # replay one input
```

Inputs are built from each format's own pieces (with Hebrew, Arabic, bidi
controls, emoji and lone surrogates), then cut, repeated and nested
thousands deep. Each decoder runs in its own worker: an exception it does
not document is a **crash**; one input running over a second is a **hang** —
the worker is stopped and the run continues. Failing inputs are saved to
`fuzz-findings/` with the command that replays them. The pass criterion is
0 crashes and 0 inputs over 1 s.

`--engine fast-check` runs the same decoders through
[fast-check](https://fast-check.dev) (with shrinking) once it is installed.

**Pathological Markdown (plan W4.16).** The first run found seven inputs
(8–14 KB) that took 0.5–2.8 s to render: thousands of `[` or `]` in one
paragraph, or lists nested 231 levels deep, make the parser's work grow with
the square of the text. A note like that would freeze the editor. Now a
block (the text between blank lines) with more than 256 brackets or more
than 32 nesting levels is shown as raw text, in a code block, exactly as
written (`src/renderer/boundMarkdown.ts`). Every real note stays far inside
both bounds and renders as before. The live preview also shows a block as
raw text once its render took more than 200 ms. The seven inputs are pinned
in `src/__tests__/markdownSlowInputs.test.ts` (each under 50 ms).

## 2. The build is reproducible

```bash
npm run repro
```

builds the same commit twice from clean (with `SOURCE_DATE_EPOCH` set to
the commit time) and compares the SHA-256 of every file in `dist/`. Any
difference is listed by file.

A release build has no source maps (plan 11.5), and the check fails if one
appears, so there is no map that could differ between two builds. Maps are
for a local investigation only (`LUMEN_SOURCEMAP=1`):
`node scripts/supply-chain/repro-check.mjs --sourcemap` builds with them and
says which fields of each differing map differ.

## 3. Every release has an SBOM

```bash
npm run sbom          # → release/sbom.cdx.json
```

A CycloneDX 1.5 list of every npm package (`package-lock.json`) and every
Rust crate (`src-tauri/Cargo.lock`): version, package URL, the lockfile's
hash and the licence. Same lockfiles, same bytes.

## 4. Every release is signed — offline

The signing key belongs to the release owner and never enters a CI system.

**Once** (on the owner's machine):

```bash
LUMEN_RELEASE_PASSPHRASE=… node scripts/supply-chain/keys.mjs --out ~/.lumen-release
cp ~/.lumen-release/lumen-release.pub security/release-key.pub   # commit this file only
```

Keep `lumen-release.key` and its passphrase offline (a password manager
and a second offline copy). Old releases stay verifiable with the old
public key if the key is ever replaced.

**Each release:**

```bash
npm run repro && npm run build
LUMEN_RELEASE_PASSPHRASE=… npm run release:sign -- --key ~/.lumen-release/lumen-release.key \
  --artifact <each desktop / mobile file>
```

This writes `release/SHA256SUMS` (every file of `dist/` and each artifact),
`release/sbom.cdx.json` and a minisign signature of each, then checks the
result. Upload the four files with the release.

**Anyone can check a release:**

```bash
npm run release:verify                      # signatures + every file against SHA256SUMS
# or with the standard tools:
minisign -Vm SHA256SUMS -P <public key from security/release-key.pub>
sha256sum -c SHA256SUMS
```

The signatures are standard minisign (Ed25519 over BLAKE2b-512), made with
Node's own crypto — no extra package.

## OpenSSF Best Practices

The [OpenSSF Best Practices badge](https://www.bestpractices.dev) is
claimed by the project owner. What it asks for, and where it is:

| Criterion | Here |
|---|---|
| Public repo, licence, contribution and security-report docs | `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` |
| Version-controlled, unique version per release, release notes | git tags, `CHANGELOG.md`, `RELEASE.md` |
| Automated tests and a test policy for new code | vitest + Playwright; every task's Definition of done |
| Static analysis and dependency scanning | ESLint, CodeQL, `npm audit`, `cargo audit`, gitleaks (`.github/workflows/security.yml`) |
| Dynamic analysis (fuzzing) | `npm run fuzz` |
| Signed releases, reproducible build | `npm run release:sign` / `release:verify`, `npm run repro` |
| A vulnerability report process with response times | `SECURITY.md` (acknowledged within 48 h, a fix timeline within 5 business days, 90-day disclosure) |
