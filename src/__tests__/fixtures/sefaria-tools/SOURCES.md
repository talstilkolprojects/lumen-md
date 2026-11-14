# Sefaria tool fixtures (plan W11.H17)

sefaria.org is not reachable from the sandbox where these were written (the
proxy refuses it), so these are **responses written from Sefaria's
documented schema** — the OpenAPI spec in Sefaria-Project `docs/openAPI.json`
(`/api/v3/texts/{tref}`, `/api/links/{tref}` → `LinkObj[]`,
`POST /api/search-wrapper` → `searchResponse`, `/api/calendars` →
`CalendarAPIResponse`), field names as the spec gives them. They are not
captured responses and not copied from the spec's examples.

- The Genesis 1:1 Hebrew line is the public-domain verse; the version titles,
  sources, the translation and the licences are made up to exercise the
  licence rules (one free version, one copyrighted).
- The commentary, search and calendar entries are illustrative; "Example 2"
  is a placeholder Daf Yomi.

Owed (Mac): record real responses for the four tools (Genesis 1:1, a search
for "love", today's calendar) and replace these, keeping the same tests.
