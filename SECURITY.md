# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Current |

## Reporting a vulnerability

**Do not put the details of a vulnerability in a public GitHub issue, discussion or pull request.**

**Today:** open a public issue titled **["Security contact request"](https://github.com/talstilkol/lumen-md/issues/new?title=Security%20contact%20request)** with no details at all, only a way to reach you if you want one. A maintainer answers within 48 hours with a private channel, and you send the report there. Include:

1. What is affected (file, feature, version or commit)
2. Steps to reproduce, or a proof of concept
3. The impact: what an attacker gets (notes read, notes changed, keys, code run, data sent off the device)
4. A suggested fix, if you have one

GitHub's private vulnerability reporting is **not turned on yet** for this repository, so the "Report a vulnerability" button does not work. Once the owner turns it on, it becomes the first channel here. A dedicated security mailbox with a published key will follow. The state of every channel is in `security/channels.json`.

### What happens next

| When | What the maintainers do |
|---|---|
| ≤ 48 hours | Answer the contact request with a private channel, then acknowledge the report there. |
| ≤ 5 business days | Confirm or reject it, give it a severity (CVSS 3.1: critical, high, medium, low) and a fix date. |
| Critical / high: ≤ 14 days · medium: ≤ 30 days · low: next release | Fix it in a **temporary private fork** (a GitHub security advisory's, once private reporting is on), so the fix is not public before the release. The fix touches a sensitive path, so it gets a human review (`human-reviewed` label, see `.github/CODEOWNERS`) like any other change there. |
| Release day | Publish the release, then a GitHub security advisory; request a CVE through it when the severity is medium or higher. The reporter is credited unless they ask not to be. |
| 90 days after the report | The latest date for disclosure, fixed or not, unless the reporter and the maintainers agree on another date. If a vulnerability is exploited in the wild, it is disclosed as soon as users can protect themselves. |

If the first maintainer does not answer within 48 hours, the second maintainer (docs: *contributing/second-maintainer*) takes the report. Both receive every report.

### In scope

- The web app (lumen-md.vercel.app and self-hosted builds), the desktop app (Tauri), the Android and iOS apps
- End-to-end encrypted sync and collaboration, the encrypted vault, the secrets store, plugin signing
- Anything that sends note content, keys or personal data off the device without the user's consent (the privacy ledger)
- CSP and header bypasses; the plugin sandbox; path traversal out of the vault folder

### Out of scope

- Attacks that need a device the attacker already controls (malware, an unlocked computer)
- Reports from automated scanners without a working attack
- Missing hardening headers on hosts Lumen does not run
- Third-party services the user connects (their own model provider, sync provider), except how Lumen uses them

We do not pursue legal action against good-faith research that follows this policy, avoids harm to users' data, and gives us the time above.

### בעברית

לא מפרסמים פרטים של חולשת אבטחה ב-issue, בדיון או ב-PR ציבוריים. **היום** פותחים issue ציבורי בכותרת **["Security contact request"](https://github.com/talstilkol/lumen-md/issues/new?title=Security%20contact%20request)** בלי שום פרט, ומתחזק עונה תוך 48 שעות עם ערוץ פרטי שאליו שולחים את הדיווח. הדיווח הפרטי של GitHub ‏(Report a vulnerability) **עוד לא מופעל** במאגר הזה, ולכן הכפתור לא עובד; כשהבעלים יפעיל אותו הוא יהיה הערוץ הראשון, ואחריו תיבת דואר ייעודית עם מפתח מפורסם. מצב כל ערוץ נמצא ב-`security/channels.json`. ניתן חומרה ותאריך תיקון תוך 5 ימי עבודה, נתקן ב-fork פרטי זמני ונפרסם את הגרסה ואז את ה-advisory (עם CVE מחומרה בינונית ומעלה, ועם קרדיט למדווח). המועד האחרון לפרסום הוא 90 יום מהדיווח. אם המתחזק הראשון לא עונה תוך 48 שעות, המתחזק השני מטפל.

## Maintainers and keys

Every key that can sign a Lumen release, plugin or reviewed commit is listed here with its fingerprint. A key that is not in this table is not ours. Changing this table is a sensitive change, so the other maintainer reviews it (`.github/CODEOWNERS`).

| Maintainer | GitHub | Commit signing key (SSH, SHA256 fingerprint) | Plugin signing key (Ed25519, SHA-256 of the SPKI) | Since |
|---|---|---|---|---|
| Tal (owner) | @talstilkol | *to add* | *to add* | — |
| Second maintainer | *open: see docs, contributing/second-maintainer* | — | — | — |

The desktop updater trusts one minisign public key (`src-tauri/tauri.conf.json`). It is held by the owner and kept in the maintainers' emergency vault (docs: *contributing/second-maintainer*, sections 6 and 7).

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
