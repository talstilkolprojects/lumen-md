/**
 * Obsidian golden files (W1.3): 40 notes in Obsidian's syntax (callouts,
 * comments, coloured highlights, footnotes, math, image embeds and sizes,
 * Hebrew and mixed), in fixtures/obsidian/. Each is rendered through the
 * full preview pipeline and checked against fixtures/obsidian/expectations.json:
 * how many elements match each selector, which text must show, and which
 * syntax must not leak into the page (`%%`, `[!`, `==`).
 *
 * "Saved unchanged" is covered by mdRoundTrip.test.ts, whose corpus includes
 * these files: both editors must write them back byte for byte.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../renderer/pipeline";
import expectations from "./fixtures/obsidian/expectations.json";

const files = import.meta.glob<string>("./fixtures/obsidian/*.md", { query: "?raw", import: "default", eager: true });

interface Expect {
  count: Record<string, number>;
  text: string[];
  absent: string[];
}

const table = expectations as Record<string, Expect>;

describe("Obsidian golden files", () => {
  it("has 40 golden files, each with expectations", () => {
    const names = Object.keys(files).map((p) => p.split("/").pop()!);
    expect(names.length).toBe(40);
    expect(names.filter((n) => !table[n])).toEqual([]);
  });

  for (const [path, md] of Object.entries(files)) {
    const name = path.split("/").pop()!;
    it(`renders ${name}`, async () => {
      const exp = table[name];
      const html = renderToStaticMarkup(await renderMarkdown(md, () => false));
      const host = document.createElement("div");
      host.innerHTML = html;
      const problems: string[] = [];
      for (const [sel, n] of Object.entries(exp.count)) {
        const got = host.querySelectorAll(sel).length;
        if (got !== n) problems.push(`${sel}: expected ${n}, got ${got}`);
      }
      const visible = host.textContent ?? "";
      for (const s of exp.text) if (!visible.includes(s)) problems.push(`missing text ${JSON.stringify(s)}`);
      // Syntax that must not leak, outside code (which keeps it on purpose).
      host.querySelectorAll("code, pre, .katex").forEach((n) => n.remove());
      const prose = host.textContent ?? "";
      for (const s of exp.absent) if (prose.includes(s)) problems.push(`leaked ${JSON.stringify(s)}`);
      expect(problems).toEqual([]);
    });
  }
});
