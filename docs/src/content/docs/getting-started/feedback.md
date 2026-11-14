---
title: Send feedback
description: Report a bug, an idea or a question as a GitHub issue or as text to copy. Lumen has no feedback server, and nothing is sent until you click.
---

Open it with `⌘K → Help: Send feedback`, or with **Report a problem…** at the
bottom of the [AI doctor](/ai/doctor/).

Lumen has no feedback server. The form turns what you write into the text of
a GitHub issue, and you choose what happens to it:

- **Open on GitHub** opens github.com in a new tab with the issue form filled
  in (title, text and a label for the kind). You check it there and submit it.
  You need a GitHub account.
- **Copy text** puts the same text on your clipboard, for an e-mail or
  anywhere else.

Until you click one of those two buttons, nothing leaves your device. The form
makes no network request, and the preview shows exactly the text that will be
sent.

## What goes in

| Part | When | What |
|---|---|---|
| Kind, title, description | always | what you wrote |
| App and browser details | ticked (the default) | Lumen version; web, installed app or desktop; platform; language; AI policy; the browser's user agent |
| AI doctor report | only when you tick it | the doctor's checks of the local AI stack. It never contains note text. Keys, tokens, passwords in URLs and e-mail addresses are removed before it goes in. |
| Screenshot | only when you take one | never part of the text (see below) |

If the issue text is too long for a link, GitHub opens with the title only and
the text is on your clipboard: paste it into the issue.

## Screenshots

**Save a screenshot to attach** asks your browser to capture a screen, window or
tab. The browser shows its own prompt, so you choose what is captured. The
picture is saved on your computer as `lumen-feedback-<date>-<time>.png`. It is
not uploaded. Attach it to the GitHub issue yourself. It may show your notes,
so look at it first.

Browsers without screen capture (most phones) say so and skip this step.
