# Third-party code in Lumen

Code from other projects that Lumen ports, adapts or copies, with the
licence each comes under. Packages installed through npm are covered by the
licence gate instead (`npm run licenses`, `licenses.allow.json`).

## Obsidian Importer

- Project: https://github.com/obsidianmd/obsidian-importer
- Version: `3.1.15`, commit `2b483d0b351c99efa8e2dd94baa8563c83d01c38`
- Licence: MIT (the text below)
- Used in (plan W11.P1):
  - `src/storage/import/keep.ts`: Google Keep's rich text, multi-line titles, annotations and timestamps, ported from `src/formats/keep/convert.ts`
  - `src/storage/import/notionDates.ts`: Notion's localized dates, ported from `src/formats/notion/date-values.ts`
  - `src/__tests__/fixtures/obsidian-importer/`: the importer's public Keep test notes, copied unchanged (see its `SOURCES.md`)

```text
MIT License

Copyright (c) 2023 Obsidian

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
