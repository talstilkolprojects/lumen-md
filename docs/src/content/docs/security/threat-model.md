---
title: Threat model
description: What Lumen protects, from whom, at each of its boundaries — vault, sync, sharing, plugins, agents and the web clipper — and where each defence is tested.
---

Privacy is Lumen's central claim, so it has to be checkable from the
outside. This page names, for every boundary where data crosses from one
party to another, the threats in each STRIDE category (**S**poofing,
**T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of
service, **E**levation of privilege), what stops them, and what is left.
Each defence points to the code or test that holds it; a row without one
is a known gap.

## What is protected

- **Notes and attachments** — the vault (browser storage, a folder, the
  phone).
- **Secrets** — AI keys, Git and cloud tokens, room passwords
  ([Secrets and encryption](/security/vault/)).
- **What the user types into AI** — prompts and the notes sent with them.
- **The app itself** — the code a user runs must be the code that was
  released ([Supply chain](/security/supply-chain/)).

## Who we defend against

| Attacker | Can | Cannot (assumed) |
|---|---|---|
| A malicious note or file (shared, imported, clipped, synced) | Put any bytes in a note, a `.canvas`, a front-matter block, a link | Run code outside the sandboxes |
| A network attacker / a relay or signaling server | Read and change traffic it carries | Break TLS or AES-GCM |
| A cloud provider (Dropbox, Drive, Gist) | Read, change, delete or hold back the files it stores | — |
| A plugin or live block | Run its own code in its sandbox | Reach the page's origin, the vault or the network without a granted capability |
| A cloud AI provider (only when the user chose one) | See what is sent to it | See anything under policy `local-only` |
| Someone with the device unlocked | Everything the user can | — (out of scope; OS lock and disk encryption) |
| A compromised dependency or build | Ship different code | Pass the signature and reproducible-build checks |

## Boundaries

### Vault (files on disk, browser storage, phone)

| | Threat | Defence | Where |
|---|---|---|---|
| T | A crash or kill half way through a save leaves a cut note | Atomic saves: temporary file, fsync, rename; recovery after restart | plan W1.5 (branch `feat/atomic-writes`, its crash test) |
| T | A path from a note, a zip or git leaves the vault (`../`) | Every path checked: no `.`/`..`/NUL segments; Rust checks the folder again | `src/storage/vault`, `src-tauri/vault` tests |
| I | A desktop WebView script reads other files | The WebView has no `fs:` permission; only the app's `vault_*` commands, inside the picked folder | `src-tauri/capabilities` |
| D | A huge or malformed file hangs the app | Decoders fuzzed: 1,000,000 inputs each, no crash, nothing over 1 s | `npm run fuzz` |
| R | "Who changed this note?" | Local history and git (when enabled); no server log exists to forge | history, safe git (3.3) |

### Sync (cloud providers, git)

| | Threat | Defence | Where |
|---|---|---|---|
| I | The provider reads the notes | End-to-end encryption before upload (plan 3.4/3.5); without it the provider sees plaintext — shown in the sync settings | `src/sync` |
| T | The provider changes or rolls back files | Authenticated encryption (AES-GCM) with versions (3.4); a conflict keeps both sides as `.conflict-<time>.md` | `src/sync/cloud/sync.ts` |
| D | The provider deletes everything | A deletion is never synced blindly; local trash and history | 3.7 data-safety matrix |
| S | A token leaks from storage | Tokens encrypted at rest; OS keychain on desktop | [Secrets](/security/vault/), `src/lib/secretStore.ts` |

### Sharing and live collaboration

| | Threat | Defence | Where |
|---|---|---|---|
| I | The signaling server or a relay reads the document | Yjs updates wrapped in AES-GCM, key from the room password (PBKDF2) | `src/collab/encryption.ts`, `e2e.ts` |
| S | Someone joins a room by knowing its name | The room password never leaves the device (it travels only in the link's `#` fragment); without it a peer gets ciphertext only | `src/collab/roomUrl.ts`, `encryption.ts` |
| T | A peer sends malformed updates | Bad tags are dropped; the document is rendered through the same sanitizer as any note | `src/collab/e2e.ts` |
| R | Edits cannot be attributed | Comments and version history carry the author locally; not a cryptographic proof (gap) | `src/collab/versionHistory.ts` |

### Plugins and live blocks

| | Threat | Defence | Where |
|---|---|---|---|
| E | Block code reaches the page, the vault or the keys | `sandbox="allow-scripts"` iframes without same-origin (an opaque origin); live-js runs only on click | `src/plugins/liveJsRunner.ts`; security e2e (plan 2.3) |
| I | A block exfiltrates over the network | CSP `connect-src` from one source; the sandbox has no network | `scripts/headers.mjs` (drift check) |
| T | Raw HTML in a note injects script | Allowlist sanitizer on raw HTML; Trusted Types | `src/renderer/rehypeSanitizeRaw.ts`, `src/lib/trustedTypes.ts` |
| E | A plugin asks for more than it says | Capabilities declared in the manifest, shown before install; scanner per version (plan 11.2, W1.20) | plugin registry |

### Agents and AI

| | Threat | Defence | Where |
|---|---|---|---|
| I | Prompts or notes reach a cloud model the user did not choose | AI policy, default `local-only`: a cloud provider is never contacted, not even as a fallback | `src/ai/policy.ts` |
| E | Prompt injection in a note makes an agent act | Every tool has a scope (`read` / `write` / `net`); a `write` or `net` tool runs only when that scope was granted for the run; workspace paths are checked | `src/agents/runtime.ts`, `src/agents/tools/workspace.ts` |
| T | A model's answer carries a link or HTML that runs | Answers render as Markdown through the sanitizer | renderer |
| D | A runaway request | Every request can be cancelled (AI: Cancel, Esc) | `src/ai/aiAbort.ts` |

### Web clipper (browser extension)

| | Threat | Defence | Where |
|---|---|---|---|
| E | The extension's broad host access is abused | It acts only on a user click (`activeTab`, context menu); no background reading of pages | `extension/manifest.json` |
| T | A clipped page carries script into a note | Clips become Markdown; raw HTML goes through the sanitizer | `extension/contentScript.js`, renderer |
| I | Clips leak to a server | The clip goes straight into the app; no Lumen server exists | — |

### Releases and dependencies

| | Threat | Defence | Where |
|---|---|---|---|
| T | A tampered download | `SHA256SUMS` + minisign signatures made offline; anyone checks with the public key | `npm run release:verify` |
| T | A build that differs from the source | Two clean builds must give the same SHA-256 per file | `npm run repro` |
| I/E | A malicious or vulnerable dependency | Lockfile only; npm audit, cargo audit, gitleaks (plan 2.8); an SBOM in every release | `.github/workflows/security.yml`, `scripts/audit-gate.mjs`, `sbom.cdx.json` |

## Known gaps

- Collaboration edits are attributed locally, not signed (R).
- An agent granted `write` writes without asking again for each file (E).
- A copied browser profile can use the stored secret key without a password
  until whole-vault encryption (11.4) ships.
- The clipper's `<all_urls>` host permission is broader than the
  click-only behaviour needs.
- The fuzzer covers the decoders on each branch; `.base`, `.excalidraw`,
  PDF annotations and plugin manifests join it as those modules land.

Found something? See [SECURITY.md](https://github.com/talstilkol/lumen-md/blob/main/SECURITY.md)
for private reporting.
