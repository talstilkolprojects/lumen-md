---
title: Checking Lumen against Obsidian
description: The owner's checklist for opening a vault Lumen saved in the real Obsidian (1.15 or later) and comparing every Bases view, row by row.
---

Lumen's tests read real vaults: ten public ones, pinned to a commit, with
their licences checked. Three of them were written by Obsidian 1.14–1.15.
The tests can't run Obsidian itself, though. This checklist does, on a Mac
with Obsidian installed. It takes about 20 minutes.

## What Obsidian 1.14–1.15 changed in files

From Obsidian's changelog (1.14.4 to 1.15.1), and what Lumen does with each:

| Change | Lumen |
|---|---|
| `groupOrder:` on a grouped view: the groups to show, in order; an empty item is "no value" | Shown in that order, and groups not listed are hidden, as the Bases reference says. A `groupOrder` that is not a list is ignored (the 1.14.4 fix). |
| Filters reordered by dragging, and moved between *All views* and *This view* | `moveFilter()` writes both. The rest of the file, comments included, is unchanged. Reordering and moving back gives the original bytes. |
| A filter value with `"` or `\` is saved escaped (1.15.0 fix) | Read as written. Lumen writes such a value the same way (`basesTextLiteral()`). |
| View keys the app writes: `columnSize`, `columnWidth`, `imageFit`, `imageAspectRatio`, `enableSearch`, `rowHeight` | Kept as written. |
| Long generated formulas (the TaskNotes plugin writes one of 2,384 characters) | Bases expressions may be up to 8,000 characters. The evaluation budget is unchanged. |
| Canvas, callouts | No file-format change in 1.15 (performance and display fixes only). |

## The checklist

1. **Make a vault Lumen saved.** Copy one of the corpus vaults
   (`src/__tests__/fixtures/obsidian-corpus/<vault>`) to a new folder and
   open that folder in Lumen. Then, in Lumen:
   - sort one view by clicking a column header;
   - edit one property of a note;
   - save one canvas;
   - save, and close Lumen.
2. **Write the probes:**
   `npm run obsidian:compare -- prepare <folder>`
   This writes one probe `.base` per view, beside each base, and installs
   the small *Lumen compare* plugin into `<folder>/.obsidian/plugins/`.
3. **Open the folder in Obsidian** (1.15.1 or later): *Open folder as
   vault*. Settings → Community plugins → turn on *Lumen compare*.
4. **Watch for warnings while it opens.** Note any notice about a `.base`
   or `.canvas` file, or about properties. There should be none.
5. **Run the probes:** command palette → *Lumen compare: Run every probe*.
   Obsidian opens each probe in turn, then each original `.base` and
   `.canvas`, and saves what it showed into `_lumen-compare/results/`.
   Wait for the notice that ends with "files opened cleanly".
6. **Compare:**
   `npm run obsidian:compare -- diff <folder> --out obsidian-diff.md`
   The report lists every view as ✅ (the same rows), ↕ (the same rows in
   another order, in a view that sorts or groups), ❌ (different rows, with
   the paths) or ⏳ (no result from Obsidian). It also lists the files
   Obsidian opened cleanly. It exits 1 if any view is ❌ or ⏳.
7. **Clean up:** `npm run obsidian:compare -- clean <folder>`
8. **Report:** attach `obsidian-diff.md` to the plan task (W6.34), and open
   an issue for each ❌ with its two path lists.

## How the comparison is fair

- Each probe sits beside its base, so `this.file`, its folder and links
  resolve the same in both apps.
- Lumen's side runs on the same files on disk, probes included, with their
  real sizes and times.
- Order is compared only where the view sorts or groups. Elsewhere neither
  app promises an order.
- The plugin uses the public Bases view API (`registerBasesView`). It makes
  no request and writes only inside `_lumen-compare/`.
