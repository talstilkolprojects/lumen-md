---
title: Academic submission (Word)
description: Export a note as a Word file formatted to an Israeli university's written guideline, with a title page, a table of contents, page numbers, footnotes and a bibliography.
---

Students write in Lumen and submit in Word. **Export for academic submission**
turns a note into a `.docx` that follows one institution's published
formatting guideline, so you don't have to fix it by hand.

## Export

`⌘K → Export for academic submission (Word)…`

1. Pick the **institution**. The line under it shows the font, size, spacing
   and margins it uses, with a link to the guideline they come from.
2. Check the **title page** fields. They start from the note's frontmatter.
3. Choose whether to add a **table of contents**, and how its page is
   numbered: no number, Hebrew letters (א, ב, ג) or Roman numerals.
4. Press **Export .docx**. Open the file in Word and press **F9** on the table
   of contents to fill in the page numbers. Word also offers to do this when
   it opens the file.

## What the file contains

- **Title page** (not numbered): the institution, faculty and department, the
  title, the kind of work, the course and its number, the lecturer, and at the
  foot of the page your name, ID number and the submission date.
- **Table of contents**: Word's own table of contents over headings 1–3, with
  links to the chapters.
- **Body**: numbered from 1 in the footer. Each top-level heading (`#`)
  starts a new page where the guideline asks for it.
- **Footnotes**: Markdown footnotes (`text[^1]` with `[^1]: the note`) become
  real Word footnotes, single-spaced and smaller, each one right-to-left or
  left-to-right by its own text.
- **Bibliography**: a heading named *Bibliography*, *References*,
  *ביבליוגרפיה*, *רשימת מקורות* or *מקורות* starts on a new page, and the
  entries under it get a hanging indent without bullets or numbers.

## Title page from the frontmatter

```yaml
---
title: Digital tools in Hebrew academic writing
subtitle: Seminar paper
faculty: Faculty of Social Sciences
department: Department of Education
course: Seminar in writing research
course_number: 12-345
lecturer: Dr. Ronit Cohen
author: Israel Israeli
student_id: "012345678"
date: March 2026
institution: biu
---
```

Hebrew keys work too: `כותרת`, `סוג העבודה`, `פקולטה`, `חוג`, `קורס`,
`מספר קורס`, `מרצה`, `מגיש`, `ת״ז`, `תאריך`, `מוסד`. The title page's labels
follow the note's language, not the app's.

## The institutions

| Institution | Covers | Font, size, spacing | Margins (right / left / top / bottom) |
| :--- | :--- | :--- | :--- |
| The Hebrew University (`huji`) | Humanities papers | David 11, double, justified | 2.54 cm (Word's default; the guideline says only not to reduce them) |
| Bar-Ilan University (`biu`) | Seminar papers | David 12, 1.5 | 2.5 cm |
| University of Haifa (`haifa`) | Master's thesis, social work | David 12, 1.5 | 3 / 2 / 2 / 2 cm |
| The Open University (`openu`) | Master's thesis, history | David 12, 1.5, front matter in Roman numerals | 3 / 2 / 2 / 2 cm |
| Tel Aviv University (`tau`) | Master's thesis, medicine | 12, 1.5 (David, 2.5 cm margins where the guideline is silent) | 2.5 cm |

Departments often have their own rules. Check yours before you submit.
Latin text uses Times New Roman throughout.
