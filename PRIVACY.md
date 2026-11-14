# Lumen Privacy Policy

**Last updated:** 2026-11-12 · [עברית](PRIVACY.he.md) (the Hebrew version also covers Israel's Privacy Protection Law, Amendment 13, and the impact assessment of the share server)

> **Not legal advice.** This document is written from the code and from public summaries
> of the law. Tal should have a privacy lawyer review it before anyone relies on it.

Lumen is a local-first Markdown editor. **By default, no note leaves your device.** This
document says what Lumen stores, where and for how long, and what each optional path sends
over the network. It matches the code: `src/__tests__/privacyDoc.test.ts` fails when the
privacy ledger can record a route this document (or the Hebrew one) does not list.

## Stored on your device
## Check it yourself

You don't have to take this page's word for it. The privacy ledger (⌘K → *Privacy ledger…*) exports a **signed report** of every request the session made, and `node scripts/privacy/verify-report.mjs` checks it. Every release is audited under the local-only policy with an outside network analyzer (mitmproxy), and the results are published per version. See the docs page *A privacy report you can prove* (`docs/src/content/docs/security/privacy-report.md`).


| Data | Where | How long |
|---|---|---|
| Notes and attachments | In the browser: OPFS (or IndexedDB). In a folder you picked, when the vault is a folder. Desktop app: a folder on disk | Until you delete them |
| Preferences (theme, language, view) | `localStorage`, keys `lumen-*` and `lumen.*` | Until you delete them ("Reset workspace state", or clearing site data) |
| API keys, sync tokens, the GitHub token, room passwords | The encrypted secret store: AES-GCM-256 under a non-extractable WebCrypto key in IndexedDB. Desktop app on macOS / Windows: the OS keychain | Until you delete them |
| The privacy ledger | In memory (up to 500 entries); the last 200 in `localStorage["lumen.privacy.ledger"]`. Each entry: time, host, method, byte counts, category, reason, policy, decision. **Never content, a prompt or a header** | Until you clear it in the panel, or newer entries push it out |
| Web vitals (page-speed metrics) | In memory only | Until the tab closes. Never sent |
| Hosts you allowed for remote images | `localStorage["lumen.remoteImages.allowedHosts"]` | Until you remove them |

## Data map: every path that leaves the device

None of these runs on its own. Each starts only when you turn a feature on, or when the
deployment's build configures it. The "In the ledger" name is exactly what the privacy
ledger panel shows. The `local-only` policy blocks every path that carries user content
(categories `cloud-ai`, `cloud-text`, `research`, `third-party`, `monitoring`, `plugin`).

| Path | What leaves | Where to | What is kept there, and for how long | In the ledger (category) |
|---|---|---|---|---|
| Cloud AI | The prompt and the text you chose to send, with your own key | The provider you picked: `OpenAI`, `Anthropic (Claude)`, `Google Gemini`, `Mistral` | The provider's policy. Lumen keeps no copy and runs no proxy | `cloud-ai` |
| Ollama | The prompt and text | `Ollama (this machine / LAN)`, or `Ollama on a remote server` if you set one | On your machine, or per that server's operator | `local-ai` / `cloud-ai` |
| Grammar check | The paragraph being checked | `LanguageTool grammar check` (api.languagetool.org or a server you set), or `LanguageTool (this machine / LAN)` | LanguageTool's policy | `cloud-text` / `local-ai` |
| PlantUML diagrams | The diagram source | `PlantUML rendering (kroki.io)`, after you allow it | kroki.io's policy | `cloud-text` |
| Model and dictionary downloads | A file request, no content of yours (the server sees your IP address) | `Model download (Hugging Face)`, `Dictionary / OCR model download (GitHub)`, `webR (R runtime) download` | The host's server logs | `model-download` |
| CDNs that should not appear | A file request | `jsDelivr CDN (only the webR download is expected)`, `Excalidraw font fallback CDN (not needed: fonts are served locally)` | The host's logs. Listed as a warning | `third-party` |
| Research | The search query and page addresses | `Research service`, `Research (local service)`, `Research (local SearXNG)` | Per the research service's operator | `research` / `local-ai` |
| Agent network tools | The agent's request, with your consent or to the configured service | `Agent tool <tool name>`. The Python agent gets no network: `Agent tool run_python: the Python sandbox has no network` | Per the destination | `research` |
| Web clipper | A request for the page you clip | `Web clipper — fetches the page you clip` | The site's logs | `third-party` |
| Read aloud with a network voice | The text being read | `Read aloud (<language>) with a network voice` (the browser vendor) | The browser vendor's policy | `cloud-text` |
| Dictation through the browser's service | Your voice | `Dictation through the browser's speech service`, `Browser speech recognition (Web Speech API)` (in Chrome, Google), only under the `cloud` policy and after you confirm | The browser vendor's policy | `cloud-text` / `cloud-ai` |
| Error reports | The error's class name and where in the code. **No** error message, text, titles, paths or page address | `Error report (Sentry / GlitchTip), content removed`, only if you turned it on **and** the build sets `VITE_SENTRY_DSN` | Per the Sentry / GlitchTip operator | `monitoring` |
| Plugins | The plugin's request | `Plugin <id>` | Per the destination | `plugin` |
| Update check (desktop app) | App version and platform only | `Desktop update check (app version and platform only)` | GitHub Releases' logs | `static-asset` |
| Jewish sources | The reference you asked for ("Berakhot 2a"), nothing from your notes | `Jewish sources (Sefaria): the reference only` (sefaria.org), when you look one up | Sefaria's policy | `cloud-text` |
| Themes and CSS snippets | A file request from a stylesheet you installed (a font or an image) | `A stylesheet (theme or CSS snippet) loaded it` | The host's logs. Listed so you can see it | `third-party` |
| Encrypted sync on the local network | Your notes, end-to-end encrypted, to your other device only | `Encrypted sync on the local network (no cloud)` | On your other device. Nothing goes to a server | `local-ai` |
| Any other request (audit mode) | Whatever that request carries | `Other request (audit mode)`: with audit mode on, every off-device request the rules above don't name is listed too | Per the destination | `network` |

Two suffixes can follow any ledger name: `(worker: <name>)` for a request from a Web
Worker, and `(redirected from <host>)` for a redirected one.

### Paths the ledger does not list

| Path | What leaves | Where to | When | What is kept there |
|---|---|---|---|---|
| Loading the app | Requests for the app's files. The host sees IP, browser, time and path. **No** notes | The host (lumen-md.vercel.app is hosted on Vercel) | Every load | Vercel's logs, per Vercel's policy |
| Encrypted sync | The vault, end-to-end encrypted: the provider sees ciphertext files, sizes and times | Your Google Drive, Dropbox, WebDAV or S3 account | Only once you set it up | At your provider until you delete it. Notes an older version synced as plain text are moved aside at the provider into `lumen-plaintext-backup-<date>` (readable) until you delete it |
| Git | Your notes as they are (not encrypted), as you choose | Your repository, through the build's CORS proxy | Only once you set it up | In your repository |
| Publish site | The notes you picked, as public HTML | GitHub Pages in your account, or a zip on your disk | Only on click | Public, until you delete it |
| Live sharing (WebRTC) | Document updates, encrypted in a password room (every new room). The signaling server sees the room name (128 random bits), IP addresses and times | Between the participants; a signaling server only if the build sets one, or if you opt into the public servers | Only while in a room | The signaling server stores no content |
| Persistent share server | See the impact assessment in [PRIVACY.he.md](PRIVACY.he.md) | A server the build sets in `VITE_YJS_WEBSOCKET_URL` | Only when configured | See there |
| Sign-in | If the build configures Supabase or WorkOS: e-mail, name and profile picture from the provider | The identity provider | Only when you sign in | At the identity provider |
| Feedback | **Nothing is sent.** The dialog builds the text of a GitHub issue; you open or copy it yourself | github.com, on your click | Only on click | Public on GitHub |
| Content from other sites in a note | A request for an image or media file. The site sees IP and time | That site, only after "Load" or "Always allow" | Only after you allow it | The site's logs |
| Embeds (YouTube, Vimeo, …) and `<iframe>` in a note | In this version they load when the note is shown | The provider | When a note with an embed opens | The provider's policy |
| Map tiles and profile pictures | A tile or image request | OpenStreetMap; GitHub / Google | In a map block; after sign-in | The host's logs |

**Not in this version yet:** a weekly usage report (task W4.26), the encrypted share link
(W5.10) and a public share server (W4.8). They join these tables when they land.

## Your rights

- **Access, correction, deletion:** your data is on your device. Open, edit or delete it
  directly. "Reset workspace state" deletes the preferences; clearing site data deletes
  everything.
- **Export:** File → Export (Markdown, HTML, DOCX, PDF).
- **Data at a provider you chose** (AI, sync, grammar): ask that provider.
- **Data on a share server the project runs:** contact the project (below) with the room
  name, and the room is deleted.

## Contact

Open an issue at <https://github.com/talstilkol/lumen-md/issues>, or e-mail the maintainer
listed in `package.json`.
