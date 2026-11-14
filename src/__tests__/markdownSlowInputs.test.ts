/**
 * Plan W4.16 — the seven Markdown inputs W1.27's fuzzer found slow (seed 1,
 * #232 #427 #559 #661 #1539 #1651 #1915: 0.5–2.8 s in the preview's chain)
 * now render in under 50 ms, because a block over the parser's bounds is
 * shown as raw text (src/renderer/boundMarkdown.ts). Notes within the bounds
 * are not changed at all.
 */
import { describe, it, expect } from "vitest";
import { generate } from "../../scripts/fuzz/generators";
import { asRawText, boundMarkdown, MAX_BRACKETS, MAX_CONTAINER_DEPTH, needsBounding } from "../renderer/boundMarkdown";
import { renderMarkdown } from "../renderer/pipeline";

const SLOW = [232, 427, 559, 661, 1539, 1651, 1915];

async function medianMs(fn: () => Promise<unknown>, runs = 5): Promise<number> {
  await fn(); // warm: the processor and its plugins are built once
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

describe("the seven slow fuzz inputs (W1.27 finding)", () => {
  it.each(SLOW)("#%i is over the bounds and renders in under 50 ms", async (i) => {
    const input = generate("markdown", 1, i);
    expect(needsBounding(input)).toBe(true);
    const ms = await medianMs(() => renderMarkdown(input, () => false));
    expect(ms, `#${i}: ${ms.toFixed(1)} ms`).toBeLessThan(50);
  }, 30_000);
});

describe("boundMarkdown", () => {
  it("leaves a note within the bounds exactly as written", () => {
    const note = [
      "# Title",
      "",
      "A [link](https://example.com), a [[Wiki Link]] and a footnote[^1].",
      "",
      "- a",
      "  - b",
      "    > quote",
      "",
      "```js",
      "const a = [[1, 2], [3]];",
      "```",
      "",
      "[^1]: Note.",
    ].join("\n");
    expect(boundMarkdown(note)).toBe(note);
    // Many links in a note, but not hundreds in one paragraph.
    const many = Array.from({ length: 60 }, (_, k) => `Para ${k} with [a](x) [b](y) [[c]].`).join("\n\n");
    expect(boundMarkdown(many)).toBe(many);
    // A long list of links with no blank line: each item is its own inline run, so it stays.
    const links = Array.from({ length: 2000 }, (_, k) => `- [link ${k}](https://example.com/${k}) and [[Note ${k}]]`).join("\n");
    expect(needsBounding(links)).toBe(false);
    expect(boundMarkdown(links)).toBe(links);
    // A table of links: each row is its own run too.
    const table = ["| a | b |", "|---|---|", ...Array.from({ length: 600 }, (_, k) => `| [x${k}](y) | [[z${k}]] |`)].join("\n");
    expect(boundMarkdown(table)).toBe(table);
  });

  it("shows a block over the bracket bound as raw text, exactly, and keeps the others", () => {
    const bad = "[".repeat(MAX_BRACKETS + 1) + " tail `code`";
    const md = `# Before\n\n${bad}\n\nAfter [a link](x).`;
    const out = boundMarkdown(md);
    expect(out).toBe(`# Before\n\n${asRawText(bad)}\n\nAfter [a link](x).`);
    expect(asRawText(bad).startsWith("```text\n")).toBe(true);
    // A fence longer than any backtick run inside.
    expect(asRawText("a ```` b")).toBe("`````text\na ```` b\n`````");
  });

  it("bounds nesting depth", () => {
    const deep = "* " + "- ".repeat(MAX_CONTAINER_DEPTH + 5) + "x";
    expect(needsBounding(deep)).toBe(true);
    expect(boundMarkdown(deep)).toBe(asRawText(deep));
    const fine = "* " + "- ".repeat(MAX_CONTAINER_DEPTH - 2) + "x";
    expect(boundMarkdown(fine)).toBe(fine);
  });

  it("never changes fenced code or math, even when they hold thousands of brackets", () => {
    const code = "```\n" + "[".repeat(5000) + "\n```";
    const math = "$$\n" + "]".repeat(5000) + "\n$$";
    const md = `${code}\n\ntext\n\n${math}\n`;
    expect(boundMarkdown(md)).toBe(md);
  });
});
