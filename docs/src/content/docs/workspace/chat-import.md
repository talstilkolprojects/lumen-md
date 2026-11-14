---
title: WhatsApp and Telegram chats into notes
description: Import an exported WhatsApp or Telegram chat into notes, one per day or one per chat, with its media, entirely on this device.
---

Decisions, recipes and study material often live in a chat. **⌘K → Import
a WhatsApp or Telegram chat…** turns an exported chat into notes. The files
are read on this device and nothing is sent anywhere.

## Export the chat

| App | How | What to pick in Lumen |
|---|---|---|
| WhatsApp (Android) | Chat → ⋮ → More → **Export chat** → with or without media → save to Files | The `.txt` (and the media files), or the `.zip` |
| WhatsApp (iPhone) | Chat → contact or group name → **Export Chat** → Save to Files | The `.zip` (it holds `_chat.txt` and the media) |
| Telegram Desktop | Chat → ⋮ → **Export chat history** → format **JSON** | `result.json`, plus the `photos/` and `files/` folders, or all of it zipped |

You can pick several files at once: the chat and its media, or more than one
chat.

## What you get

Each chat becomes a folder in `Imported/`, for example
`Imported/Family (WhatsApp)/`, with:

- **one note per day** (`2026-11-12.md`), or **one note for the whole chat**
  with a heading per day. You choose when you import.
- frontmatter: the app, the chat, the date, the participants and the number
  of messages.
- every message in order, with its time and author. System lines (someone
  joined, encryption notices) are in italics.
- media copied into `media/` next to the notes: pictures shown in place,
  other files linked. A file the export left out is named in the note, so
  nothing disappears silently.
- WhatsApp's `*bold*`, `_italic_` and `~strike~` become Markdown, and
  Telegram's bold, links and code blocks are kept.

Nothing existing is overwritten: a second import of the same chat goes into
a new folder (`… 2`). The folder is marked as outside content, so AI agents
treat its text as other people's words.

## Dates in every language

The export is written in the phone's language, and Lumen reads both Hebrew
and English exports:

- Hebrew: `12.11.2026, 14:03 - טל: …` and 12-hour times with לפנה״צ / אחה״צ.
- English: US `11/12/26, 2:03 PM - …` and day-first `12/11/2026, 14:03`.
- Arabic, with Arabic-Indic digits and ص / م. The digits are read as numbers
  only in the date and time: a message keeps the digits it was written with.
- iPhone's `[12.11.2026, 14:03:12]` form, and the invisible direction marks
  iPhones add around names and attachments.
- An export without media: Android's `<Media omitted>` / `<המדיה לא נכללה>`,
  and the iPhone's line per kind, in English and in Hebrew (`image omitted` /
  `התמונה הושמטה`, `video omitted` / `סרטון הווידאו הושמט`, voice, GIF,
  sticker, document and contact card). A document keeps its file name.

WhatsApp doesn't write the date order anywhere, so Lumen works it out from the
whole file: a number over 12 must be the day. Otherwise, if the dates only run
forward when read one way, that way is right. When every date could still be
read either way, dots mean day first, slashes with an English AM/PM mean the
US order, and slashes with an Arabic or Hebrew clock (ص / م, לפנה״צ / אחה״צ)
mean day first. Otherwise the day comes first, as in Israel and Europe.

## One message into the inbox

A single message shared or pasted into **Quick capture** keeps where it came
from. WhatsApp's copied form `[14:03, 12.11.2026] Tal: …` and Telegram
Desktop's `Tal, [12.11.2026 14:03]` become an inbox entry that starts with
`WhatsApp · Tal · 2026-11-12 14:03`. On Android, the share sheet sends the
message to the installed app (see [Quick capture](/workspace/quick-capture/)).
Plain text is captured as before.
