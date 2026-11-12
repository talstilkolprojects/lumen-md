---
title: Mail and Google Takeout into notes
description: Import .eml and .mbox mail and a Google Takeout archive (Keep, Docs) into notes, from files only, with Hebrew mail in every old encoding.
---

**⌘K → Import mail (.eml, .mbox) or Google Takeout…** reads mail and Google
data **from files only**. No account is connected and nothing leaves this
device.

## What you can pick

| Source | File |
|---|---|
| Single messages | `.eml`, saved from any mail app |
| Mailboxes | `.mbox`: Gmail's Takeout, Thunderbird, Apple Mail |
| Google Takeout | the `takeout-….zip`, with **Mail** (an `.mbox` with Gmail labels), **Keep** and **Drive** |

When the mailbox has Gmail labels, Lumen asks which label to import, or all
of them. Each label is shown with its message count.

## What you get

Everything goes into new folders in `Imported/`, and nothing existing is
overwritten:

- **Mail**: one note per **thread**, linked by `Message-ID`, `In-Reply-To`
  and `References`. Without those headers, the subject is used, minus `Re:`,
  `Fwd:`, `השב:` and `הועבר:`. Messages run oldest first, each under the
  sender and date, with To/Cc. Attachments are copied to `attachments/`:
  pictures are shown in place, other files linked. The frontmatter holds the
  subject, participants, first and last date, and labels.
- **Google Keep**: one note per Keep note. You get the text, the checklist
  as `- [ ]` / `- [x]`, labels as tags, created and edited times, pinned and
  archived, the attachments and the links. Notes in Keep's trash are left
  out, and the report says how many.
- **Google Docs**: Takeout exports Docs as `.docx` by default, and they
  become Markdown. `.odt`, `.rtf`, `.html`, `.txt` and `.md` work too. Any
  other Drive file is copied as it is, in its folder.

The folders are marked as outside content, so AI agents treat their text as
other people's words.

## Hebrew mail in old encodings

Mail from older Israeli systems often isn't UTF-8. Lumen reads:

- **windows-1255** and **ISO-8859-8-I**: Hebrew in logical order, as typed.
- **ISO-8859-8**: in MIME this label means **visual** order. Each line is
  stored as it looks on a left-to-right screen, so the Hebrew reads
  backwards (RFC 1555 and the Hebrew-mail draft that followed it). Lumen
  turns those lines around and keeps English words, numbers and links in
  their own order. Many mail apps also put normal, logical text under this
  label. Lumen tells the two apart by the final letters (ך ם ן ף ץ): they end
  words in logical text and start them in visual text. A plain כ מ נ פ צ at
  the end of a word is another sign of visual text.
- Encoded-words in subjects and names (`=?windows-1255?B?…?=`, `?Q?`, in
  any charset), file names in the `filename*=utf-8''…` form, and raw 8-bit
  headers.

## Large mailboxes

A 5,000-message mbox is read and turned into notes in about a second (measured
in the test suite; the plan's limit is 2 minutes). The whole file is read into memory, so a Takeout mbox of several GB
is best split by label in Takeout first (one `.mbox` per label).
