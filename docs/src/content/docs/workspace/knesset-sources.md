---
title: Laws and Knesset records
description: Cite a law by its name, a bill and a committee protocol from the Knesset's open data, keep laws for offline use, and ask the laws you saved.
---

Write a law's name the way you usually do: `חוק הגנת הפרטיות`,
`חוק הגנת הפרטיות, התשמ״א-1981`, `לחוק הגנת הפרטיות`, `[[חוק:חופש המידע]]`,
or a Basic Law as `חוק יסוד: כבוד האדם וחירותו` or `ח״י: כבוד האדם וחירותו`.
Lumen finds the law in the Knesset's public records (its OData service) and
inserts a citation with a link to the record.

## Turn it on

Knesset sources start **off**. The first time you use one of the commands,
Lumen asks to turn them on. You can turn them off again in **Open sources**.

## Cite a law

1. Put the cursor on a line that names a law, or select the name.
2. Open the command palette and choose **Cite a law (Knesset)…**.
3. Lumen asks before it sends anything. Only the name is sent to
   `knesset.gov.il`, never your note. The request is listed in the
   privacy ledger.
4. When more than one law matches, pick one.

The toast offers **Save for offline**. A saved law is a note in
`Sources/Knesset/Laws/` with its source, the date it was retrieved and its
rights in the frontmatter. The next time you cite it, Lumen finds it there
and sends nothing, online or not.

## Rights

Section 6 of the Copyright Act, 2007 says there is no copyright in laws,
regulations, Knesset records (דברי הכנסת) and judicial decisions. So a
saved law may hold the full text: paste it under `## נוסח`. Documents
attached to a session, such as legal opinions and presentations, are not
Knesset records, so Lumen keeps only their link.

## Bills

**Cite a bill (Knesset)…** searches bills by a word of their name, saves the
one you pick in `Sources/Knesset/Bills/` and links to it.

## Committee protocols

Open a committee protocol's text in Lumen, select the words, and choose
**Quote from this committee protocol**. The quote gets the speaker, the
session date and the page, written after the Uniform Citation Rules, for
example: `פרוטוקול ישיבה מס' 12 של ועדת החוקה, חוק ומשפט, הכנסת ה-25, 2 (3.1.2023)`.
Nothing is sent: the details come from the protocol's first lines.

## Ask the law

**Ask the law…** searches the sections of the laws you saved, on this
device, and inserts the section you pick, quoted word for word with its
citation. That is a **quote from the law, not a verified answer**: nothing
checks that the section answers your question, and the note says so.

With a model on this device (Ollama, or the in-browser model), Lumen also
writes a short answer from that one section, and a critic checks it
against the section's text. The answer is marked verified only when the
critic finds the section supports it. An answer with a number the section
doesn't contain (a deadline, an amount) is never verified, whatever the
model says. Without a local model there is no answer and nothing is
verified, only the quote. The cloud is never used for this.

## What is not here yet

- Court decisions (a separate study of the Judiciary's terms comes first).
- Fetching a law's consolidated text: the Knesset's OData service has the
  law's details, not its text, so you paste the text yourself.
