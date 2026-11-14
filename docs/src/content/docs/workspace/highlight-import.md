---
title: Import highlights (Kindle, Kobo, Readwise, Zotero)
description: Bring your highlights from Kindle, Kobo, Readwise and Zotero into the vault, one note per book, with no duplicates when you import again.
---

Run `⌘K → "Import highlights (Kindle, Kobo, Readwise, Zotero)…"`, pick
where the highlights come from, then pick the file.

| From | What to pick |
|---|---|
| **Kindle** | `My Clippings.txt` in the Kindle's `documents` folder (connect it by USB). |
| **Kobo** | `KoboReader.sqlite` in the reader's hidden `.kobo` folder. |
| **Readwise** | The CSV export: Readwise → Export → CSV. |
| **Zotero** | Nothing to pick: Zotero 7 on this computer, desktop app only (see below). |

Every book or article gets a note, `Highlights/<Title> — <Author>.md`. Each
highlight is a quote with:

- its place (page, location, or chapter and %);
- the date;
- tags and your note;
- for Zotero, a link that opens the annotation in its PDF.

Hebrew titles and texts work, file names included.

## Import again, any time

Importing the same file again only adds what's new:

- A highlight that's already in the note is left as it is, including any
  edits you made to it.
- If the app changed it (for example, you edited its note in Readwise),
  the entry is updated.
- A highlight you extended on the Kindle replaces the shorter one.
- The same passage from two apps (a Kindle highlight that Readwise also
  has) is **one** entry.
- Whatever you write in the note outside the highlights is kept.

Bookmarks, Kobo dog-ears and Zotero image or ink annotations have no text
and are left out; the import says how many.

Imported highlights appear in [All highlights](/workspace/highlights/)
under the kind **Imported**, and can be searched like the rest.

## Zotero

Zotero 7 serves your library to other apps on the same computer.

1. Turn it on in Zotero: **Settings → Advanced → "Allow other applications
   on this computer to communicate with Zotero"**.
2. With Zotero open, run the import in the **desktop app**. It reads your
   annotations from `127.0.0.1` (your own computer) and never from the
   cloud.

Zotero refuses requests from web pages, so in the browser the import
explains this instead.

Nothing is uploaded: the files are read on this device, and the only
request made is the desktop app's request to Zotero on this computer.
