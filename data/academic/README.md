# Academic calendars (plan W7.8)

One file per institution and Hebrew year: `data/academic/<institution>/<year>.json`.
The schema is `AcademicYear` in `src/academic/calendar.ts`.

- Dates are facts: copy them from the institution's official calendar and
  link that document in `source.url`.
- Set `"verified": true` only after every field was checked against the
  document. Lumen shows nothing from an unverified file.
- `node scripts/academic/check-calendar.mjs data/academic/<id>/<year>.json <golden.json>`
  compares a file field by field with a golden table typed from the document.

To add an institution, open a pull request with its file and the link.

These files were written in a sandbox that could not open the documents, so
they hold the institution and the link only (`verified: false`). Filling them
is the owner's step in plan W7.8.
