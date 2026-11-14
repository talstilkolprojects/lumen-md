# Markdown spec test files (vendored, unmodified)

These two files are the official spec test suites that
`src/__tests__/mdConformance.test.ts` runs Lumen's Markdown syntax against.
They are copied byte for byte. Nothing in them was changed.

| File | Source | Commit | SHA-256 |
| --- | --- | --- | --- |
| `commonmark-0.31.2.txt` | [commonmark/commonmark-spec](https://github.com/commonmark/commonmark-spec) `spec.txt`, tag `0.31.2` | `9103e341a973013013bb1a80e13567007c5cef6f` | `257c41ad946f7a1414a499aca402a1aa8fdac3678532266611348c1cf54f4b80` |
| `gfm-0.29.txt` | [github/cmark-gfm](https://github.com/github/cmark-gfm) `test/spec.txt` (GitHub Flavored Markdown Spec 0.29-gfm) | `27d942c8b0a62d192f616e5bf3578f4b6a89e180` | `7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c` |

## Licence

Both files are released under the Creative Commons Attribution-ShareAlike 4.0
International licence (CC BY-SA 4.0), <https://creativecommons.org/licenses/by-sa/4.0/>.

- CommonMark Spec: Copyright (C) 2014-16 John MacFarlane.
- GitHub Flavored Markdown Spec: based on the CommonMark Spec, Copyright (C)
  2014-16 John MacFarlane, with the GFM extensions by GitHub, Inc.

The licence applies to these two files only. It does not extend to the rest of
the repository, which only reads them as test data. If you redistribute them,
keep this notice and the licence link.

## Updating

Replace a file with a newer upstream copy, update the table above (commit and
`sha256sum`), and the example counts in `mdConformance.test.ts`, then run
`npm run md:conformance`. The test checks the example counts, so a file that
went out of step fails loudly.
