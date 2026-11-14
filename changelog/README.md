# changelog/

Translations of `CHANGELOG.md` for the in-app "What's new" (plan 14.6), one file per interface language (`he.md`, `ar.md`, …), with the same `## [x.y.z] - date` sections.

`node scripts/release.mjs prepare` copies each new English section into every file here, marked `<!-- untranslated -->`. Translate the section and delete that line. Until then the app shows the English notes under the language's own headings, and says they aren't translated yet.
