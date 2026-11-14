# NOAT: rules for AI agents

NOAT is an Obsidian vault for LSE MISDI students (any student can adapt it). Each student has their own copy and uses it for lecture, seminar, reading and concept notes, deadlines, job applications and books. Dashboards read each note's frontmatter, so a note only shows up if its folder, properties and values are exactly right. Your job: answer questions from the student's notes, and add or update notes in NOAT's structure without breaking anything.

## Rules that override everything

1. **Never edit** `.obsidian/`, `00 Meta/Bases/`, `Manual/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or any note with a `🔒 Template file` callout at the bottom (`🏠 Main Dashboard`, `📚 Modules`, the `📊` dashboards, the `MG406/472/481/487/496` dashboards).
2. **Never delete, move or rename** a student's note without asking first. When editing a note, change only what was asked and keep its other properties.
3. **Answer from the vault first** and name the notes you used. Ignore example notes (below) unless asked about them.
4. **Write final values only.** You can't run Templater, so never write `<% %>` code.
5. **If a request doesn't fit a note type or rule here, ask.** Don't invent folders, properties, values or tags.
6. If `00 Meta/AI/About me.md` exists, read it at the start of the session. It's the student's file: edit it only when they ask.

## Folder map

| Folder | What belongs there |
| --- | --- |
| `01 UNI/01 Modules/<CODE Title>/` | The module dashboard `<CODE>.md` (has a `code` property), and lecture, seminar, workshop and guest talk notes |
| `…/<CODE Title>/Deadlines/` | Exams, essays, projects and other dated items for that module |
| `…/<CODE Title>/00 Meta/` | Slides and handouts (non-Markdown files) |
| `01 UNI/02 Concepts/` | One idea per note, in the student's words |
| `01 UNI/03 Literature/` | Papers, readings, book chapters and cases. PDFs go in `PDFs/` |
| `01 UNI/My electives.md` | The student's Winter Term electives table (the student's file) |
| `Job Hunt/` | One note per job application |
| `Books/` | One note per book (optionally `Books/<Title>/` with its PDF or cover) |
| `Daily Notes/` | Optional diary notes, named `DD-MM-YYYY` |
| `00 Meta/Attachments/` | Pasted images. `00 Meta/Bases/` holds the dashboards' `.base` files (don't touch) |

**Example notes:** any file whose name starts with `EXAMPLE` or that has the tag `example`. They are fake. Shipped deadline notes such as `MG472 Exam` are real, not examples.

## Where to look first

| Question about… | Read |
| --- | --- |
| A topic, idea or "what did we cover" | `01 UNI/02 Concepts`, then class notes in the module folder, then `01 UNI/03 Literature`. Follow `[[links]]` and backlinks between them |
| Deadlines, exams, grades | `01 UNI/01 Modules/*/Deadlines/*.md` |
| Weak spots, what to revise | The `understanding` property across `01 UNI` (🔴 and 🟠 first) |
| Unfinished notes | `progress` is `📝 Brief notes` or `✍️ Writing up` |
| Job applications | `Job Hunt/*.md` tagged `job-application` |
| Books | `Books/` |
| To-dos | `- [ ]` lines under a `### TODO` heading, or with `📅 YYYY-MM-DD` |
| Term dates and week numbers | The italic lines under each term heading in `📚 Modules.md` (Week 1 = the week the term starts) |

**Dashboards are live Dataview and Bases queries, not data.** Don't read answers off them. Read the frontmatter of the actual notes and compare dates with today's date. Treat a deadline as done if `status` is `Submitted`, `Graded` or `Done`. If `due` is empty, report `due_note` (e.g. "ST exam period"). An application is "closing soon" if `status` is `Not applied` (or empty) and `deadline` is upcoming. `rolling: true` means there's no fixed deadline.

## Note types

All dates are `YYYY-MM-DD`. Links in frontmatter must be quoted: `course: "[[MG472]]"`. Values must match exactly, including capitals and emoji:

- `understanding`: `🔴 No clue` · `🟠 Shaky` · `🟡 Getting there` · `🟢 Solid` (or empty = not rated)
- `progress`: `📝 Brief notes` · `✍️ Writing up` · `✅ Complete`

`course` must be the module dashboard's exact name (the module code). Check that the dashboard exists.

**Class note** (`type`: `Lecture` · `Seminar` · `Workshop` · `Guest Talk`). Save it **inside the module folder**. Name it `MG472 W03 Lecture - Network economics`.

```yaml
course: "[[MG472]]"
term: AT
week: 3
type: Lecture
date: 2026-10-16
lecturer: Dr Antonio Cordella
materials:
  - "[[Week 3 slides.pdf]]"
readings:
  - "[[Shapiro & Varian (1999) Information Rules]]"
tags:
  - MG472
understanding: 🟡 Getting there
progress: 📝 Brief notes
```

**Reading or case** (`type`: `Case` · `Paper` · `Book Chapter` · `Reading`). Save it in `01 UNI/03 Literature/`. Name it `Author (year) Short title`, or `Case - Starbucks digital transformation`.

```yaml
course: "[[MG472]]"
week: 3
type: Paper
authors:
  - Allan Afuah
materials:
  - "[[Afuah 2013.pdf]]"
understanding: 🟠 Shaky
progress: 📝 Brief notes
```

**Concept**. Save it in `01 UNI/02 Concepts/`. The name is just the idea, e.g. `Critical mass`. Add `week: 3` only if there's no `source-lecture`.

```yaml
course: "[[MG472]]"
type: concept
source-lecture: "[[MG472 W03 Lecture - Network economics]]"
understanding: 🔴 No clue
tags:
  - concept
```

**Deadline**. Save it in `<module folder>/Deadlines/`. Name it `MG481 Essay`.

- `type: Assessment` is for marked work. It has `weight` and `grade`, and its `status` is `Not started` · `In progress` · `Submitted` · `Graded`.
- `type: Deadline` is for anything else with a date. It has no `weight` or `grade`, and its `status` is `Not started` · `Done`.
- If the date is unknown, leave `due` empty and set `due_note` (e.g. `TBC, see Moodle`).

```yaml
course: "[[MG481]]"
type: Assessment
weight: 50%
due: 2026-11-02
due_note:
status: Not started
grade:
tags:
  - MG481
```

**Job application**. Save it in `Job Hunt/` and name it `Company - Role`. It **must** have the tag `job-application`. Allowed values:

- `status`: `Not applied` · `Applied` · `Online test` · `Interview` · `Assessment centre` · `Offer` · `Rejected` · `Withdrawn` · `Closed`
- `programme`: `Full Time Graduate` · `Summer Internship` · `Spring Week / Insight` · `Placement` · `Experienced Hire`
- `career_path`: `Consulting` · `Tech / Product` · `Business Analysis` · `Strategy` · `Data / AI` · `Finance`
- `sponsorship`: `Yes` · `No` · `Unknown`

Leave unknown fields empty but keep them. These are also allowed: `salary`, and `outcome_reason` (why it ended).

```yaml
company: Acme
role: Graduate Analyst
programme: Full Time Graduate
career_path: Consulting
location: London
deadline: 2026-11-20
rolling: false
link: https://…
status: Applied
applied_date: 2026-10-28
next_step: Online test
next_step_date: 2026-11-04
sponsorship: Unknown
tags:
  - job-application
```

**Book**. Save it in `Books/`. Its properties are `author`, `status` (`To read` · `Reading` · `Finished` · `Abandoned`), `started`, `finished`, `topic`, `rating` (`1` to `5`), `cover`, `pdf` and `reviewed` (`true`/`false`).

**To-do**. This is a line inside any note, not a note of its own: `- [ ] Email the seminar leader 📅 2026-11-03`. It reaches the Main Dashboard only if it's under a `### TODO` heading, or due within 7 days. To tick one off, write `- [x] … ✅ YYYY-MM-DD`.

**New module.** Create `01 UNI/01 Modules/<CODE Title>/` with `00 Meta/` and `Deadlines/` inside it. Copy an existing module dashboard into it as `<CODE>.md`, change only its `#` title line and its `code`, `module`, `term`, `convenor`, `assessment` and `credit` properties, then add a row to `My electives`. Confirm with the student first.

## Writing and linking

- Use `[[wikilinks]]`, and only to notes that exist. Check first. Link each new note to its module (`course`), readings and concepts. If a link target doesn't exist, ask before creating it.
- The body is up to the student. A useful shape: a one-line `> [!summary]`, headings written as questions with a `>` short answer under each, a self-test section and a `### TODO` heading.
- Always put a blank line before a table, or it won't render. Inside a table, write a link with a label as `[[MG472\|Label]]`.
- Formatting that works: standard Markdown, tables, `- [ ]` tasks, `![[embeds]]` and callouts (`note`, `tip`, `summary`, `info`, `question`, `example`, `warning`, `danger`, `todo`, `abstract`, `caution`; add `-` after the brackets to fold one shut, e.g. `> [!tip]-`). `cssclasses: [wide-page]` makes a note wider. Don't use `[!nav]`, `cssclasses: dashboard`, raw HTML or `<% %>` in student notes.
- Name files without these characters: `/ \ : * ? " < > |`. Don't create notes called `Untitled`.

## Answering questions

- Answer from the student's notes and list the notes you used as `[[links]]`.
- If the vault doesn't cover something, say so clearly. If the student wants general knowledge as well, label it **not from your notes**.
- For any deadline or assessment detail, remind them that NOAT is unofficial and Moodle is the official source.
