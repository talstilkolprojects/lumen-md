# Lumen Privacy Policy

**Last updated:** 2026-05-22

Lumen is a local-first markdown editor. **By default, no data leaves your device.** This document describes what data Lumen handles, where it lives, and the few cases where data crosses the network.

## TL;DR

| Data | Where it lives | Leaves your device? |
|---|---|---|
| Your documents | OPFS (origin-private file system in your browser) | **No** |
| Editor preferences (theme, locale, view mode, etc.) | `localStorage["lumen-md"]` | **No** |
| Search history | `localStorage["lumen-search-history"]` | **No** |
| Onboarding state | `localStorage["lumen-tour-done"]` | **No** |
| OAuth tokens (Google Drive, Dropbox) | `localStorage["lumen.gdrive.token"]`, `localStorage["lumen.dropbox.token"]` | Only when **you** opt-in to cloud sync |
| AI API key | In-memory only (never persisted) | Sent to the AI provider you configured (e.g. OpenAI) on each request |
| Error reports | Off by default. | Only if **you** turn them on (status bar) **and** your operator configured `VITE_SENTRY_DSN`; note text, titles and paths are removed, and each report is listed in the privacy ledger |
| Web vitals (page-speed metrics) | In memory on your device | **No**, never |
| Collab session state | Peer-to-peer over WebRTC | Only between you and your collab peers |

## Local storage breakdown

Lumen uses two browser storage layers:

1. **OPFS** for documents and assets. This is sandboxed per-origin and is the modern replacement for IndexedDB blobs. The contents of your workspace stay on your device unless you explicitly export, publish, or sync them.
2. **localStorage** for small key/value preferences. The complete list of keys is namespaced under `lumen-*` and `lumen.*`. You can wipe all of it via the in-app "Reset workspace state" affordance (which calls `clearAllLumenLocalStorage()`).

## Cloud sync (opt-in)

If you configure Google Drive or Dropbox sync from Settings, Lumen will:

- Initiate an OAuth flow with the chosen provider.
- Store the returned access/refresh tokens in `localStorage`.
- Push and pull your workspace documents to/from the provider's API.

Lumen does NOT proxy these requests through any Lumen-operated server. The browser talks directly to Google or Dropbox.

If you revoke the tokens (provider dashboard or in-app sign-out), sync stops immediately and the tokens are removed from `localStorage`.

## AI features (opt-in)

If you configure an AI provider (OpenAI by default) and enter an API key:

- The key is held in memory for the duration of your session only (never persisted to localStorage or any other storage).
- AI requests go directly from your browser to the provider's API. Lumen does not proxy.
- Local-only AI is available via WebLLM (`@mlc-ai/web-llm`). When enabled, no AI requests leave your device.

## Collab (opt-in)

When you join a collab room:

- A Yjs document is shared peer-to-peer over WebRTC.
- The default signaling server is the public `wss://signaling.yjs.dev`. You can configure your own via Settings.
- Document changes are encrypted in transit (DTLS via WebRTC). Lumen does not log or persist them.

## Telemetry

Off by default. Error reports are sent only when **you** turn them on with the Telemetry pill in the status bar **and** the build sets `VITE_SENTRY_DSN` (Sentry or a self-hosted GlitchTip). Without both, the Sentry SDK is never loaded. A report carries only the error's class name and where in the code it happened. The error message, note text, titles, file paths, the page address, breadcrumbs and user data are never sent. There is no session replay. Every report is listed in the privacy ledger, and the local-only policy blocks them. Web vitals are measured on your device and never sent. Details: `docs/src/content/docs/security/monitoring.md`.

## GDPR / CCPA rights

Because all your data lives on your device, your rights are exercised directly:

- **Right to access**: open the app — your data is there.
- **Right to delete**: clear browser storage for the Lumen origin OR use the in-app "Reset workspace state" affordance OR delete individual documents.
- **Right to export**: use File → Export to download your workspace as Markdown / HTML / DOCX / PDF.
- **Right to rectification**: edit your documents directly.

If you use a hosted version and it serves a third-party signaling/sync, contact the operator (see the hosted instance's footer) for rights-related questions.

## Contact

Open an issue at <https://github.com/talstilkol/lumen-md/issues> or email the maintainer listed in `package.json`.
