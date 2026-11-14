# Zotero Web API fixtures (plan W5.23)

Shaped like the documented Web API v3 responses (zotero.org/support/dev/web_api/v3/basics):
`/keys/current`, an item with `include=data,csljson`, a child note, a PDF attachment and
`/collections`. api.zotero.org is not reachable from the sandbox these were written in, so they
were **written from the documentation, not recorded**; names and IDs are made up and the key is
redacted. Tal's run against a real library (owner command in the PR) is the check that the real
responses match.

W6.47 adds the write side, written the same way from
zotero.org/support/dev/web_api/v3/write_requests (a POST of up to 50 objects answers
`successful` / `success` / `unchanged` / `failed`, keyed by the index in the request) and the
annotation item fields Zotero 7 stores (`annotationType`, `annotationText`, `annotationComment`,
`annotationColor`, `annotationPageLabel`, `annotationSortIndex`, `annotationPosition`):
`keys-current-write.json` (a key with write access) and `write-annotations-response.json`
(one saved, one refused). Not recorded either: a real write to a test library is owed.
