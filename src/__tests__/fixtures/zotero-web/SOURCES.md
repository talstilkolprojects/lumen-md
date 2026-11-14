# Zotero Web API fixtures (plan W5.23)

Shaped like the documented Web API v3 responses (zotero.org/support/dev/web_api/v3/basics):
`/keys/current`, an item with `include=data,csljson`, a child note, a PDF attachment and
`/collections`. api.zotero.org is not reachable from the sandbox these were written in, so they
were **written from the documentation, not recorded**; names and IDs are made up and the key is
redacted. Tal's run against a real library (owner command in the PR) is the check that the real
responses match.
