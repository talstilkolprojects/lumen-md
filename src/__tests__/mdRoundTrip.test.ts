/**
 * Round trip through both editors (W1.2): open a real Markdown file, save
 * it, and get the same bytes back.
 *
 * Corpus: every Markdown file in the repository (English and Hebrew docs,
 * templates, READMEs, eval goldens, …) plus each heading section of the
 * two vendored spec files, which are themselves long Markdown documents full
 * of edge cases. A CRLF copy of every tenth file is added on
 * top. The suite asserts at least 200.
 *
 * - Source editor (CodeMirror): open and save must be byte-identical for
 *   every file, CRLF and mixed endings included (lineEndings.ts).
 * - WYSIWYG (Milkdown, with the editor's own syntax plugins): open, save
 *   unedited, and save after typing one character into the last paragraph.
 *   Unedited must be byte-identical and the edit may change only the block
 *   it touched (sourcePreserve.ts). Gate: 98% of the corpus (196 of 200);
 *   the failures are listed in the report.
 *
 * Reports: test-results/md-roundtrip/report.{json,md}, with a per-file diff of
 * Milkdown's own serialization next to the preserved save.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { math } from "@milkdown/plugin-math";
import { getMarkdown } from "@milkdown/utils";
import type { Node as PmNode } from "@milkdown/prose/model";
import { listSpreadFix } from "../editor/milkdownListSpread";
import { wysiwygObsidianPlugins } from "../editor/wysiwygObsidian";
import { encodeCriticForWysiwyg, wysiwygSuggestPlugins } from "../editor/wysiwygSuggest";
import { splitFrontmatter } from "../editor/WysiwygEditor";
import { lineSeparatorFor } from "../editor/lineEndings";
import { splitMarkdownBlocks, wysiwygSourcePreserver } from "../editor/wysiwygSource";
import cmSpec from "./fixtures/md-spec/commonmark-0.31.2.txt?raw";
import gfmSpec from "./fixtures/md-spec/gfm-0.29.txt?raw";

vi.mock("../ai/llm", () => ({
  chat: vi.fn(),
  chatStream: vi.fn(),
  AiError: class AiError extends Error {},
}));

interface CorpusFile {
  name: string;
  text: string;
}

const repoFiles = import.meta.glob<string>(
  ["/**/*.md", "!/**/node_modules/**", "!/test-results/**", "!/reports/**", "!/dist/**", "!/coverage/**"],
  { query: "?raw", import: "default", eager: true },
);

/** The spec split at its headings, levels 1 to 4 (never inside a code fence). */
function specSections(name: string, text: string): CorpusFile[] {
  const parts: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/(?<=\n)/)) {
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (fence === null && f) fence = f[1];
    else if (fence !== null && f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
    else if (fence === null && /^#{1,4} /.test(line) && cur.length) {
      parts.push(cur.join(""));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) parts.push(cur.join(""));
  return parts.filter((s) => s.trim().length > 0).map((s, i) => ({ name: `${name} §${i + 1}`, text: s }));
}

const base: CorpusFile[] = [
  ...Object.entries(repoFiles)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, text]) => ({ name, text })),
  ...specSections("commonmark-0.31.2.txt", cmSpec),
  ...specSections("gfm-0.29.txt", gfmSpec),
];
const corpus: CorpusFile[] = [
  ...base,
  ...base
    .filter((_, i) => i % 10 === 0)
    .map((f) => ({ name: `${f.name} (CRLF)`, text: f.text.replace(/\r?\n/g, "\r\n") })),
];

function firstDiff(a: string, b: string): string {
  if (a === b) return "";
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const line = a.slice(0, i).split("\n").length;
  const show = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 50));
  return `line ${line}: file ${show(a)} → saved ${show(b)}`;
}

interface WysiwygRow {
  name: string;
  raw: boolean;
  unedited: boolean;
  edited: boolean | null;
  pass: boolean;
  rawDiff: string;
  detail: string;
}
const rows: WysiwygRow[] = [];
const cmRows: { name: string; pass: boolean; detail: string }[] = [];

afterAll(async () => {
  try {
    const fs = await import("node:fs");
    const dir = "test-results/md-roundtrip";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify({ codemirror: cmRows, wysiwyg: rows }, null, 2));
    const ok = rows.filter((r) => r.pass).length;
    const raw = rows.filter((r) => r.raw).length;
    const md = [
      "# Markdown round trip",
      "",
      `Corpus: ${corpus.length} files.`,
      "",
      `- Source editor: ${cmRows.filter((r) => r.pass).length}/${cmRows.length} byte-identical.`,
      `- WYSIWYG, preserved save: ${ok}/${rows.length} pass (unedited identical, edit touches one block).`,
      `- WYSIWYG, Milkdown's own serialization: ${raw}/${rows.length} identical.`,
      "",
      "| File | Unedited | Edited | Milkdown serialization |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (r) =>
          `| ${r.name} | ${r.unedited ? "yes" : "NO"} | ${r.edited === null ? "n/a" : r.edited ? "yes" : "NO"} | ${
            r.raw ? "identical" : r.rawDiff.replace(/\|/g, "\\|")
          } |`,
      ),
      "",
      "## Failures",
      "",
      ...rows.filter((r) => !r.pass).map((r) => `- ${r.name}: ${r.detail}`),
      ...cmRows.filter((r) => !r.pass).map((r) => `- (source editor) ${r.name}: ${r.detail}`),
    ];
    fs.writeFileSync(`${dir}/report.md`, md.join("\n"));
  } catch {
    // why: the report file is an optional extra; the assertions above decide the test
    // No file system: the assertions carry the result.
  }
});

describe("round-trip corpus", () => {
  it("has at least 200 real files, Hebrew included", () => {
    expect(base.length).toBeGreaterThanOrEqual(200);
    expect(corpus.filter((f) => /[֐-׿]/.test(f.text)).length).toBeGreaterThanOrEqual(10);
    expect(corpus.some((f) => f.text.includes("\r\n"))).toBe(true);
  });
});

describe("source editor (CodeMirror) round trip", () => {
  it("drops the \\r of a CRLF file without a line separator (the bug this fixes)", () => {
    const crlf = "# a\r\n\r\nb\r\n";
    expect(EditorState.create({ doc: crlf }).doc.toString()).toBe("# a\n\nb\n");
  });

  it("keeps CRLF, CR and mixed endings with lineSeparatorFor", () => {
    for (const text of ["# a\r\n\r\nb\r\n", "a\rb\r", "a\r\nb\nc\rd\n", "no break", "", "a\n\n"]) {
      const s = EditorState.create({ doc: text, extensions: [EditorState.lineSeparator.of(lineSeparatorFor(text))] });
      expect(s.doc.toString()).toBe(text);
      // An edit and its undo (insert, then delete) also give the bytes back.
      const edited = s.update({ changes: { from: 0, insert: "x" } }).state;
      const back = edited.update({ changes: { from: 0, to: 1 } }).state;
      expect(back.doc.toString()).toBe(text);
    }
  });

  it("writes every corpus file back byte for byte", () => {
    for (const f of corpus) {
      const s = EditorState.create({ doc: f.text, extensions: [EditorState.lineSeparator.of(lineSeparatorFor(f.text))] });
      const edited = s.update({ changes: { from: s.doc.length, insert: "x" } }).state;
      const back = edited.update({ changes: { from: edited.doc.length - 1, to: edited.doc.length } }).state;
      const out = back.doc.toString();
      cmRows.push({ name: f.name, pass: out === f.text, detail: firstDiff(f.text, out) });
    }
    expect(cmRows.filter((r) => !r.pass).map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
  });
});

async function openWysiwyg(text: string) {
  const { fm, body } = splitFrontmatter(text);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const ed = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, encodeCriticForWysiwyg(body));
    })
    // The same syntax plugins, in the same order, as WysiwygEditor.tsx.
    .use(wysiwygSuggestPlugins)
    .use(commonmark)
    .use(gfm)
    .use(listSpreadFix)
    .use(wysiwygObsidianPlugins)
    .use(math)
    .create();
  const loaded = ed.action(getMarkdown());
  return { ed, host, fm, body, loaded, preserver: wysiwygSourcePreserver(body, loaded) };
}

/** Original blocks found, in order, in the saved text. */
function keptBlocks(original: string, saved: string): { kept: number; total: number } {
  const blocks = splitMarkdownBlocks(original);
  let at = 0;
  let kept = 0;
  for (const b of blocks) {
    const i = saved.indexOf(original.slice(b.start, b.end), at);
    if (i >= 0) {
      kept++;
      at = i + (b.end - b.start);
    }
  }
  return { kept, total: blocks.length };
}

describe("WYSIWYG (Milkdown) round trip", () => {
  it(
    "saves unedited files byte for byte and an edit touches only its own block",
    async () => {
      for (const f of corpus) {
        const row: WysiwygRow = { name: f.name, raw: false, unedited: false, edited: null, pass: false, rawDiff: "", detail: "" };
        rows.push(row);
        let opened: Awaited<ReturnType<typeof openWysiwyg>> | null = null;
        try {
          opened = await openWysiwyg(f.text);
          const { ed, fm, body, loaded, preserver } = opened;
          row.raw = fm + loaded === f.text;
          row.rawDiff = firstDiff(f.text, fm + loaded);
          const unedited = fm + preserver.restore(loaded);
          row.unedited = unedited === f.text;
          if (!row.unedited) row.detail = `unedited: ${firstDiff(f.text, unedited)}`;

          const view = ed.action((ctx) => ctx.get(editorViewCtx));
          let at = -1;
          view.state.doc.descendants((n: PmNode, pos: number) => {
            if (n.isTextblock && !n.type.spec.code && n.content.size > 0) at = pos + n.nodeSize - 1;
            return true;
          });
          if (at >= 0) {
            view.dispatch(view.state.tr.insertText("Z", at));
            const saved = preserver.restore(ed.action(getMarkdown()));
            const { kept, total } = keptBlocks(body, saved);
            row.edited = saved.includes("Z") && kept >= total - 1 && saved.startsWith(body.slice(0, splitMarkdownBlocks(body)[0]?.start ?? 0));
            if (!row.edited) row.detail += ` edited: kept ${kept}/${total} blocks`;
          }
        } catch (e) {
          row.detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          if (opened) {
            await opened.ed.destroy(true).catch(() => {
              // why: teardown of an editor that may already be gone; its failure is recorded in the row
            });
            opened.host.remove();
          }
        }
        row.pass = row.unedited && row.edited !== false;
      }
      const passed = rows.filter((r) => r.pass).length;
      console.log(
        `WYSIWYG round trip: ${passed}/${rows.length} pass; Milkdown's own serialization identical for ${rows.filter((r) => r.raw).length}`,
      );
      expect(passed).toBeGreaterThanOrEqual(Math.ceil(rows.length * 0.98));
    },
    900_000,
  );
});
