---
title: Messages, empty states and undo
description: How Lumen talks when something fails, when a panel is empty, and before it deletes anything — and the guide for writing those messages.
---

Lumen holds three promises about the moments people notice most:

1. **An error says what happened, what is safe, and what to do** — never a
   stack trace, an error code or a library's own words.
2. **An empty panel shows the way out**: one short sentence and one action.
3. **Nothing you made is deleted without a way back**: the action can be
   undone, or it asks first.

## Errors

Every error shown in the app goes through `explainError(e)`
(`src/lib/userError.ts`). It recognises the kind of failure and shows one
sentence for it, in the user's language; the raw text goes to the log, where
the AI doctor and a bug report can read it.

| Kind | What the person reads |
|---|---|
| no space | This device is out of storage space. Your text is still open here; free some space or export the vault, then try again. |
| permission | The browser did not allow this. Nothing was changed; allow access when it asks, then try again. |
| network | No connection. Your notes are safe on this device; try again when you are online. |
| timeout | This took too long and was stopped. Nothing was lost; try again, or try a smaller piece. |
| not found | The file is no longer there (moved or deleted). Nothing else changed; look for it in the trash or reopen it. |
| damaged file | The file could not be read: it is damaged or in another format. Nothing was changed; check the file and try again. |
| name taken | Something with that name is already there. Nothing was overwritten; choose another name. |
| AI busy | The AI service is busy (too many requests). Nothing was lost; wait a minute and try again. |
| no AI key, privacy policy, no local model | what was (not) sent, and where to change it |
| anything else | Something went wrong. Nothing you wrote is lost; try again, and if it happens again, the AI doctor and the log have the details. |

A cancel the person did themselves (closing a file picker, pressing Stop)
shows nothing. An error whose words are already written for the person
(translated, with what to do) is thrown as a `UserFacingError` and shown as
it is.

One exception is allowed: the syntax error of the person's **own** code or
diagram (Mermaid, Graphviz, PlantUML, ABC, SQL, a database block's query),
because its line and token are what they need to fix it. Each one is marked
`raw-error-allow` in the code.

## Writing a message (the guide)

- **What happened** — in the person's terms, not the program's: "The file
  could not be read", not "SyntaxError: Unexpected token".
- **What is safe** — say what did not happen: "Nothing was changed", "Your
  text is still open here", "Nothing was sent".
- **What to do** — one concrete next step: "free some space", "try again when
  you are online", "add a key in AI settings".
- No blame ("you entered an invalid…"), no codes, no exclamation marks, no
  "Oops". One or two short sentences.
- In Hebrew: plural address (נסו, בחרו) as in the rest of the app; the verb
  first ("שום דבר לא השתנה"); product and format names stay in Latin script
  (Ollama, WebGPU, ‎.zip).

## Empty states

Every empty panel — the file tree, search, outline, backlinks, tags,
comments, the graph, the trash, version history, templates, the audit log,
the privacy ledger, the AI panels — is an `<EmptyState>` with one action:
*New note*, *Clear the search*, *Add a heading*, *Copy a link to this note*,
*Keep a version now*, and so on. The component's `action` is required.

## Destructive actions

Moving a note to the trash offers **Undo**; deleting from the trash for good,
emptying the trash, clearing the agent runs, deleting a comment, removing the
Hebrew dictionary, a git pull (which replaces files — and now moves files
deleted upstream to the trash instead of deleting them), applying the Vault
Doctor's link fixes and clearing the style profile **ask first**. A command
that deletes or replaces data declares `destructive: "confirm" | "undo"`.

## How it is checked

Three gates run in the unit tests (`src/__tests__/respectfulMessages.test.ts`)
and can be run alone:

```sh
node scripts/check-raw-errors.mjs     # 0 raw error texts on screen
node scripts/check-empty-states.mjs   # every empty state has an action
node scripts/check-destructive.mjs    # every destructive action asks or can be undone
```
