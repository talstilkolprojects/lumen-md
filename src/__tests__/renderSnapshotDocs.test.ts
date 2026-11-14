/**
 * Plan 8.1, review 13.5: the repository documents that the fixed
 * 50-document set (renderSnapshot.test.ts) leaves out, rendered through the
 * same preview pipeline.
 *
 * TERMS, PRIVACY, RELEASE and RELEASE_NOTES are compared with a file
 * snapshot each (__snapshots__/render-docs/). MASTER_PLAN.md is generated
 * from plan/plan.json (scripts/plan/build.mjs) and changes with every plan
 * update, at about 500 KB, so a byte snapshot of it would fail on every plan
 * commit. It is checked by structure instead: every Markdown heading becomes
 * one heading element, every board row a table row, and nothing is dropped
 * or escaped as raw text. Regenerate the file snapshots with
 * `npx vitest run -u src/__tests__/renderSnapshotDocs.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../renderer/pipeline";
import { StaticRenderContext } from "../renderer/components";

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

async function html(markdown: string): Promise<string> {
  const tree = await renderMarkdown(markdown, () => false);
  return renderToStaticMarkup(createElement(StaticRenderContext.Provider, { value: true }, tree));
}

export const DOCS = ["TERMS.md", "PRIVACY.md", "RELEASE.md", "RELEASE_NOTES_2026-05-01.md"] as const;

describe("render snapshots: the repository documents outside the 50-document set", () => {
  for (const rel of DOCS) {
    const name = `doc-${rel.replace(/\.md$/, "").replace(/[/.]/g, "-").toLowerCase()}`;
    it(name, async () => {
      await expect(await html(read(rel))).toMatchFileSnapshot(`__snapshots__/render-docs/${name}.html`);
    }, 30_000);
  }

  it("MASTER_PLAN.md: every heading and every table row is rendered", async () => {
    const md = read("MASTER_PLAN.md");
    const out = await html(md);
    // ATX headings and GFM tables outside fenced code. A table is a run of lines
    // starting with "|" whose second line is the delimiter row; each other line is a <tr>.
    const lines = md.split("\n");
    let fenced = false;
    let headings = 0;
    let rows = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
      if (fenced) continue;
      if (/^#{1,6}\s+\S/.test(lines[i])) headings++;
      if (lines[i].startsWith("|") && !lines[i - 1]?.startsWith("|") && /^\|[\s:|-]+$/.test(lines[i + 1] ?? "")) {
        let j = i;
        while (j < lines.length && lines[j].startsWith("|")) j++;
        rows += j - i - 1;
        i = j - 1;
      }
    }
    expect(headings).toBeGreaterThan(20);
    expect(rows).toBeGreaterThan(100);
    // GFM adds one (visually hidden) heading for the footnotes section.
    const footnotes = /^\[\^[^\]]+\]:/m.test(md) ? 1 : 0;
    expect((out.match(/<h[1-6][\s>]/g) ?? []).length).toBe(headings + footnotes);
    expect((out.match(/<tr>/g) ?? []).length).toBe(rows);
    // Nothing of the Markdown table syntax survives as text.
    expect(out).not.toMatch(/<p[^>]*>\|/);
  }, 60_000);
});
