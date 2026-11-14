/**
 * "Open sample workspace" (LAUNCH-READINESS B6).
 *
 * Seeds a small, interlinked demo folder into the in-browser workspace
 * (OPFS) so a new user can see wiki-links, tags, a database view over
 * frontmatter, a chart, a Mermaid diagram, a task list and a template
 * working together — instead of an empty file tree.
 *
 * Safety contract: NEVER overwrites. Each file is written only when its
 * path doesn't exist yet, so re-running the command is idempotent and any
 * edits the user made to the sample survive.
 */
import { joinPath, workspaceHasFile, writeWorkspaceFile } from "./workspace";

export const SAMPLE_ROOT = "Lumen Sample";
export const SAMPLE_ENTRY = "Start Here.md";

export interface SampleFile {
  /** Path relative to the sample root. */
  path: string;
  content: string;
}

export function sampleWorkspaceFiles(root: string = SAMPLE_ROOT): SampleFile[] {
  const projects = joinPath(root, "Projects");
  return [
    {
      path: SAMPLE_ENTRY,
      content: `---
title: Start Here
tags: [sample, index]
---

# 👋 Welcome to the Lumen sample workspace

This folder is a tiny, linked knowledge base. Every note below is plain Markdown stored in your browser — edit, rename or delete anything.

## Where to go next

- [[Project Board]] — a **database view** built from note frontmatter
- [[Website Redesign]] — a project note with a **Mermaid** diagram
- [[Metrics]] — a **CSV table** and an **ECharts** chart
- [[Weekly Review]] — a **template** you can copy for each week

Open the backlinks panel on any note to see which notes point at it.

## Try this

- [x] Open the sample workspace
- [ ] Click a [[Metrics|wiki-link]] (aliases work too)
- [ ] Filter the file tree by the \`#project\` tag
- [ ] Drag a card on the [[Project Board]]
- [ ] Duplicate the [[Weekly Review]] template
`,
    },
    {
      path: "Project Board.md",
      content: `---
title: Project Board
tags: [sample, database]
---

# Project Board

Every note in \`Projects/\` with \`type: project\` in its frontmatter shows up here. Change a note's \`status:\` and the card moves column.

\`\`\`database
title: Projects by status
source: ${projects}
type: project
view: kanban
groupBy: status
sortBy: due
fields: [title, owner, due, status]
\`\`\`

The same data as a table:

\`\`\`database
source: ${projects}
type: project
view: table
sortBy: -priority
fields: [title, owner, priority, due]
\`\`\`

Back to [[Start Here]].
`,
    },
    {
      path: "Projects/Website Redesign.md",
      content: `---
title: Website Redesign
type: project
status: In progress
owner: Dana
priority: 3
due: 2026-12-01
tags: [project, design]
---

# Website Redesign

Part of the [[Project Board]]. Launch metrics live in [[Metrics]].

## Release flow

\`\`\`mermaid
graph LR
  A[Design review] --> B{Approved?}
  B -- yes --> C[Build pages]
  B -- no --> A
  C --> D[QA]
  D --> E[Launch 🚀]
\`\`\`

## Tasks

- [x] Audit the current site
- [x] Wireframes for home + pricing
- [ ] Accessibility pass
- [ ] Launch announcement — draft with the [[Weekly Review]] template
`,
    },
    {
      path: "Projects/Mobile App.md",
      content: `---
title: Mobile App
type: project
status: Planned
owner: Omer
priority: 2
due: 2027-02-15
tags: [project, mobile]
---

# Mobile App

Offline-first companion app. Depends on the [[Website Redesign]] design system.

- [ ] Pick the sync strategy
- [ ] Prototype the editor screen
`,
    },
    {
      path: "Projects/Docs Refresh.md",
      content: `---
title: Docs Refresh
type: project
status: Done
owner: Noa
priority: 1
due: 2026-09-30
tags: [project, docs]
---

# Docs Refresh

Shipped! Page-view numbers are tracked in [[Metrics]].

- [x] Rewrite the getting-started guide
- [x] Add screenshots
`,
    },
    {
      path: "Metrics.md",
      content: `---
title: Metrics
tags: [sample, data]
---

# Metrics

Paste CSV straight into a fenced block and Lumen renders a sortable table with chart suggestions:

\`\`\`csv title="Weekly visitors"
week,visitors,signups
W1,1200,48
W2,1350,61
W3,1610,70
W4,1980,92
\`\`\`

Or write an explicit chart:

\`\`\`chart
xAxis: { type: category, data: [W1, W2, W3, W4] }
yAxis: { type: value }
tooltip: { trigger: axis }
series:
  - { name: Signups, type: line, smooth: true, data: [48, 61, 70, 92] }
\`\`\`

Used by [[Website Redesign]] and [[Docs Refresh]].
`,
    },
    {
      path: "Templates/Weekly Review.md",
      content: `---
title: Weekly Review — {{date}}
type: template
tags: [template]
---

# Weekly Review — {{date}}

> Duplicate this note each week (or install it from ⌘K → *Insert template*) and fill in the blanks.

## Wins

-

## Blockers

-

## Next week

- [ ]
- [ ]

Linked projects: [[Project Board]]
`,
    },
  ];
}

export interface SampleWorkspaceResult {
  root: string;
  /** Workspace path of the note to open first. */
  entry: string;
  created: string[];
  skipped: string[];
}

/**
 * Write the sample notes under `root`, skipping any path that already
 * exists. Throws only on storage errors (e.g. OPFS unavailable).
 */
export async function createSampleWorkspace(
  root: string = SAMPLE_ROOT,
  files: SampleFile[] = sampleWorkspaceFiles(root),
  entry: string = SAMPLE_ENTRY,
): Promise<SampleWorkspaceResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const full = joinPath(root, file.path);
    if (await workspaceHasFile(full)) {
      skipped.push(full);
      continue;
    }
    await writeWorkspaceFile(full, file.content);
    created.push(full);
  }
  return { root, entry: joinPath(root, entry), created, skipped };
}

/**
 * The sample in the reader's language (plan 14.1): Hebrew for a Hebrew
 * interface, English otherwise. The Hebrew notes load only when asked for.
 */
export async function createLocalizedSample(lang: string): Promise<SampleWorkspaceResult> {
  if (lang !== "he") return createSampleWorkspace();
  const { SAMPLE_ROOT_HE, SAMPLE_ENTRY_HE, sampleWorkspaceFilesHe } = await import("./sampleWorkspaceHe");
  return createSampleWorkspace(SAMPLE_ROOT_HE, sampleWorkspaceFilesHe(SAMPLE_ROOT_HE), SAMPLE_ENTRY_HE);
}
