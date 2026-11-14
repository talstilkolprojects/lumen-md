# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Current |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report it privately through GitHub: **[Report a vulnerability](https://github.com/talstilkol/lumen-md/security/advisories/new)** (Security → Advisories), with:

1. A description of the vulnerability
2. Steps to reproduce
3. Impact assessment (what data or functionality is affected)
4. Your suggested fix, if any

We will acknowledge receipt within **48 hours** and provide a timeline for a fix within **5 business days**.

## Security architecture

Lumen is a **local-first** application. By default, no data leaves the browser.

### Data at rest

| Store | Encryption | Scope |
|---|---|---|
| OPFS workspace | Plaintext (browser-sandboxed) | Same origin only |
| IndexedDB (git, search index) | Plaintext (browser-sandboxed) | Same origin only |
| Secrets vault (`⌘K → Vault`) | AES-256-GCM, PBKDF2-derived key | User passphrase required |
| localStorage (preferences) | Plaintext | Same origin only |

### Data in transit

| Feature | Transport | Encryption |
|---|---|---|
| P2P collaboration | WebRTC (DTLS/SRTP) | Transport encrypted via WebRTC DTLS (hop-by-hop between peers; signaling servers, relays and the optional persistent y-websocket server are not covered). Password-protected rooms additionally encrypt document updates end-to-end — see [`docs/src/content/docs/collab/encryption.md`](docs/src/content/docs/collab/encryption.md). Rooms without a password are **not** end-to-end encrypted. |
| Signaling server | WSS (TLS 1.2+) | Transport-layer only |
| AI prompts (OpenAI) | HTTPS (TLS 1.2+) | Transport-layer only |
| Smart search embeddings | HTTPS to OpenAI | Transport-layer only |
| Git clone/push | HTTPS | Transport-layer only |

### Plugin sandbox

Third-party plugins run in a sandboxed `<iframe>` with:

- `sandbox="allow-scripts"` — **no** `allow-same-origin`
- CSP: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: data:; connect-src https:`
- Communication restricted to a `postMessage` API with an explicit allowlist of callable methods
- Plugin signatures verified via Ed25519 (WebCrypto `verify()`) before installation

### Telemetry

- Error reports are **off by default**. They are sent only when the user turns them on (the Telemetry pill in the status bar) **and** the build sets `VITE_SENTRY_DSN`. Without both, the Sentry SDK is never loaded and no request is made.
- A Sentry DSN is **public by design, not a secret**: it only lets a client submit events. A build-time `VITE_*` variable is the intended place for it.
- `beforeSend` rebuilds each event from an allowlist: the error's class name, plus stack frames reduced to script file names. The message is never sent, because it may embed user text without quotes. The request URL, user, breadcrumbs, tags, extra and contexts are dropped. There is no session replay, no tracing and no session tracking.
- Reports go through the privacy ledger under the "monitoring" category, and the local-only policy refuses them. The DSN's host reaches the CSP only through the build-time endpoint mechanism (`src/build/cspEndpoints.ts`); no tracker host or wildcard is hard-coded.
- Web vitals are measured locally and never sent.

### Authentication

- Auth is always optional — Lumen works fully without an account
- When configured, auth uses Supabase (JWT-based) or a custom `AuthProvider`
- API keys are stored in the encrypted secrets vault, not in plaintext localStorage
- The `localProvider` (default) always returns an anonymous session

### Known limitations

- OPFS data is not encrypted at rest (relies on browser origin isolation)
- WebRTC P2P rooms are ephemeral. Signaling servers see room names and peer metadata; without a room password, anything routed through a signaling/relay or persistent sync server is not end-to-end encrypted. Use a room password for end-to-end encryption of document updates (see `docs/src/content/docs/collab/encryption.md`)
- PlantUML rendering uses the public Kroki API (diagram source is sent to `kroki.io`)
- `htmlpreview` fenced blocks execute user-authored HTML/JS in a sandboxed iframe

## Dependencies

- `npm audit` is run in CI on every push — the gate requires **0 critical / 0 high** vulnerabilities
- Dependabot is configured for automated security updates (`.github/dependabot.yml`)
- The `uuid` package is pinned via `overrides` to avoid transitive vulnerabilities

## Disclosure timeline

We follow a **90-day disclosure policy**. If a fix is not released within 90 days of the initial report, the reporter may publish details publicly.
