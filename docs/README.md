# Lumen Docs

User-facing documentation for Lumen, built with [Astro Starlight](https://starlight.astro.build/).

## Develop

```bash
cd docs
npm install
npm run dev          # http://localhost:4321
```

## Build

```bash
npm run build        # → dist/
```

From the repository root, `npm run docs:build` does the whole thing:

1. installs the docs' dependencies;
2. builds the site, which runs Pagefind;
3. re-indexes with the pinned Pagefind release binary if the build left no index (`scripts/docs-pagefind.mjs`);
4. runs the 20 golden Hebrew search queries against the real index (`scripts/docs-search.mjs --site docs/dist`).

## GIFs

`npm run docs:gifs` (repository root) records the 30 docs GIFs in Hebrew from
the running app into `docs/public/gifs/`. The flows are in `e2e/gifs/flows.ts`,
and the recorder is `e2e/gifs/record.gifs.ts` with `playwright.gifs.config.ts`.
The GIFs are encoded in plain JavaScript (`scripts/lib/gif.mjs`), with no
ffmpeg. To record a single GIF, run `npm run docs:gifs -- --grep palette`.

## Discussions

See [dev/github-discussions.md](dev/github-discussions.md).

Deploy `dist/` to any static host. We point `docs.lumen.app` at Cloudflare
Pages with `npm run build` as the build command.

## Structure

```
docs/
├── astro.config.mjs           # sidebar, locales, integrations
└── src/content/docs/
    ├── index.mdx              # home / hero
    ├── getting-started/       # welcome, quickstart, shortcuts
    ├── editor/                # modes, smart insert, slash menu
    ├── blocks/                # one page per renderer (mermaid, csv, …)
    ├── workspace/             # OPFS, wiki-links, database views, search
    ├── collab/                # webrtc, persistent, encryption
    ├── ai/                    # settings, smart-search, agents, local-llm, mcp
    ├── plugins/               # gallery, templates, web-clipper
    ├── sync/                  # git, cloud, publish
    ├── security/              # vault, privacy
    └── faq.md
```

Hebrew translations live alongside English under each route — the sidebar
config supports both.
