# Knesset fixtures (plan W7.5)

The Knesset's OData service could not be reached from the sandbox where these
were written (the proxy refuses knesset.gov.il), so they are **recorded
fixtures written from the documented schema**, not captured responses:

- `laws.v4.json`: an OData V4 answer for `KNS_IsraelLaw`. Field names follow the
  Knesset schema as hasadna/knesset-data-pipelines records it
  (`laws/knesset.source-spec.yaml`). The law names are real titles;
  `IsraelLawID` values (900001…) are placeholders, not the Knesset's ids.
- `names.json`: 50 ways of writing those names.
- `askTheLaw.json`: excerpts of five laws and 20 questions. Test data for the
  local search, not an authoritative text.
- `protocol.txt`: a synthetic committee protocol in the Knesset's text layout
  (`<< יור >>` / `<< דובר >>` markers, colon speakers, page numbers). The
  names and the bill are invented.

Owner check (live): `node scripts/sources/live-check.mjs knesset` compares the
real service with these shapes.
