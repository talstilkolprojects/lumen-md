---
title: Settings
description: One screen for every setting — tabs, search, and export / import of your choices.
---

Open **Settings** from the command palette (`⌘K` → *Settings*). Every
older settings dialog now opens here, on its own tab:

| Tab | What it holds |
| --- | --- |
| General | View mode, theme, language, text direction, panels, editor switches (Vim, typewriter, spelling, grammar, TypeScript checks, suggesting), auto-save, daily writing goal, local AI, error reports |
| Theme | Accent color, fonts, size, line height, content width, presets |
| AI settings | AI policy and cost mode, who runs the agents, Ollama address and model, the model manager (downloads, storage), local grammar and research services, writing style |
| Collaboration settings | Signaling server, public signaling fallback, persistent server and its token |
| Train AI on my style | Fine-tuned model and whether AI requests use it |
| Trusted signing keys | The Ed25519 keys plugins must be signed with |
| Organization | Name, allowed email domains, SSO, audit log |

## Search

Type in the search box at the top. Lumen matches the name of every
setting — including the ones inside a tab, such as *Ollama* or
*signaling* — and shows only the tabs that have a match. In the General
tab, only the matching settings stay on screen.

## Export and import

**Export JSON** downloads `lumen-settings.json` with your choices. It never
contains:

- API keys, tokens or passwords;
- your notes, open tabs, caches or history;
- the trusted plugin-signing keys or the organization policy.

**Import JSON** reads such a file back. Each value is checked against the
settings table: an unknown name, a secret, or a value of the wrong type is
skipped, and the toast tells you how many settings were imported and how
many were skipped. An import never loosens the AI policy: a file that says
*Cloud* doesn't move a device that keeps AI on this device to the cloud —
change that yourself in the AI tab.

## For developers

Every stored key and every persisted store field is listed in
`src/settings/schema.ts`, with its kind (`setting`, `secret` or `data`),
its tab and its label. `src/__tests__/settingsSchema.test.ts` scans the
sources and fails when a new key is missing from the table, so the screen,
its search and its export can't fall behind.
