---
title: Templates
description: Start a note from a template — the built-in ones, the gallery, and the ones you install — and where an installed template lives.
---

## Start from a template

The command palette lists templates as commands. Pick one and it opens
as a **new, unsaved tab**: it never writes into the note you have open,
and a name that is already taken gets a number (*Meeting notes 2.md*).

## The template gallery

`⌘K → Browse template gallery` opens the gallery: filter by category,
search by name, and **Install** a template. Installing writes it to
`templates/<id>.md` in your vault and adds it to the palette under
**Templates: <name>**. It is an ordinary note, so you can edit it like
any other. With the interface in Hebrew, templates that have a Hebrew
version install in Hebrew.

The gallery's list ships with the app (`public/templates/registry.json`),
so browsing it makes no request to any other site.

## Adding a template to the gallery

See `public/templates/CONTRIBUTING.md` in the repository: one Markdown
file plus an entry in `registry.json` (and a Hebrew file under
`public/templates/he/` when there is one).
---
title: Templates and sample vaults
description: The template gallery, the twenty Israeli templates with their Bases views, placeholders, importing a template from a file, and the three sample vaults.
---

**⌘K → Browse template gallery** opens the gallery. **Install** copies a
template into your workspace as `templates/<id>.md`; from then on it is in
**⌘K → Templates**, and choosing it opens a new, unsaved note from it. The
gallery speaks the UI's language: in Hebrew you get the Hebrew name,
description and body of every template that has one.

## Templates for Israeli use cases

Twenty templates, each in Hebrew and in English:

| Area | Templates |
|---|---|
| Journal | Daily journal (with the Hebrew date), weekly review (Sunday–Thursday) |
| Student | University course (semester, credits), exam (Moed A / B), lecture summary, seminar paper |
| Research | Article to read, research log / experiment |
| Work | Team meeting, one-on-one, project (kanban), task |
| Home | Recipe (meat / dairy / pareve, Shabbat), holiday plan, apartment hunting (₪ rent, arnona, va'ad bayit) |
| Reading and writing | Book I'm reading, book chapter, character |
| Personal | Reserve duty (miluim) log, job application (kanban) |

Every one of them stores its facts as **properties** in the frontmatter, with
English keys (`type`, `status`, `due`…) and values in your language, so the
same note works in Lumen and in Obsidian.

### A Bases view with every template

Each template comes with a companion [`.base` file](/workspace/obsidian-bases/).
Installing the template also writes it to `Bases/` (for example
`Bases/Courses.base`, or `Bases/קורסים.base` in Hebrew): a table, cards or
kanban view of every note with that template's `type`, with column names in
your language. If the file is already there, it is left alone, so your
changes to the view survive a reinstall.

## Placeholders

When a template becomes a note, these are filled in — the same names as
Obsidian's core Templates plugin:

| Placeholder | Becomes |
|---|---|
| `{{title}}` | the note's name |
| `{{date}}` | today, `YYYY-MM-DD` |
| `{{time}}` | now, `HH:mm` |
| `{{hebrewDate}}` | today in the Hebrew calendar, for example `30 Heshvan 5787` |

Anything else in double braces is left as it is.

## Import a template from a file

**⌘K → Import template from file…**, or **Import from file…** at the top of
the gallery, copies a Markdown file you pick into `templates/`. A name that
is taken gets a number (`Recipe.md`, then `Recipe 2.md`), and characters that
can't be in a file name are replaced with spaces. The template is in
**⌘K → Templates** straight away.

## Sample vaults

Three ready-made vaults show the templates, links and Bases views working
together. Each opens from the command palette, in the UI's language, into a
folder of its own:

- **Open sample vault: student** — two courses, lecture summaries and an
  exam with a study plan; views of courses, lectures and exams.
- **Open sample vault: researcher** — a thesis, three articles and two
  experiments; views of the literature, the research log and the papers.
- **Open sample vault: writer** — three chapters and three characters,
  linked to each other; views of the manuscript and the characters.

Like the sample workspace, a sample vault never overwrites anything: running
it again only adds the files that are missing.
