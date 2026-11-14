/**
 * Tests for the pure helpers in `src/agents/commands.ts`. The AI calls themselves
 * (suggestTags / suggestLinks) hit OpenAI and require live network — those
 * are integration territory. The frontmatter merge + link-application
 * helpers are pure markdown manipulation worth pinning down.
 */

import { describe, it, expect } from "vitest";
import {
  mergeTagsIntoFrontmatter,
  applyLinkSuggestion,
  type LinkSuggestion,
} from "../agents/commands";

describe("mergeTagsIntoFrontmatter", () => {
  it("creates fresh frontmatter when none exists", () => {
    const out = mergeTagsIntoFrontmatter("# Body", ["machine-learning", "paper"]);
    expect(out).toContain("---\ntags:");
    expect(out).toContain("machine-learning");
    expect(out).toContain("paper");
    expect(out).toContain("# Body");
  });

  it("inserts a new tags line into existing frontmatter", () => {
    const input = "---\ntitle: Foo\n---\n\nbody";
    const out = mergeTagsIntoFrontmatter(input, ["new"]);
    expect(out).toContain("title: Foo");
    expect(out).toContain("tags:");
    expect(out).toContain('"new"');
    expect(out).toContain("body");
  });

  it("merges with an existing tags array (deduped)", () => {
    const input = '---\ntags: [existing, machine-learning]\n---\n\nbody';
    const out = mergeTagsIntoFrontmatter(input, ["machine-learning", "new-tag"]);
    // "machine-learning" appears once (deduped), "new-tag" added,
    // "existing" preserved.
    const tagsLine = out.split("\n").find((l) => l.startsWith("tags:")) ?? "";
    const tagCount = (tagsLine.match(/machine-learning/g) ?? []).length;
    expect(tagCount).toBe(1);
    expect(tagsLine).toContain("existing");
    expect(tagsLine).toContain("new-tag");
  });

  it("returns input unchanged when given empty tag list", () => {
    expect(mergeTagsIntoFrontmatter("body", [])).toBe("body");
  });

  it("preserves body content unchanged", () => {
    const body = "## H2\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```";
    const out = mergeTagsIntoFrontmatter(body, ["x"]);
    expect(out).toContain(body);
  });
});

describe("applyLinkSuggestion", () => {
  it("wraps a phrase in a wiki-link on first occurrence", () => {
    const content = "Today I learned about neural networks.";
    const s: LinkSuggestion = {
      phrase: "neural networks",
      target: "Neural Networks",
      reason: "topic match",
    };
    const out = applyLinkSuggestion(content, s);
    expect(out).toBe("Today I learned about [[Neural Networks|neural networks]].");
  });

  it("only replaces the first match", () => {
    const content = "Cats are great. Cats deserve naps. Cats are wise.";
    const s: LinkSuggestion = {
      phrase: "Cats",
      target: "Cats",
      reason: "x",
    };
    const out = applyLinkSuggestion(content, s);
    const linkCount = (out.match(/\[\[Cats\|Cats\]\]/g) ?? []).length;
    expect(linkCount).toBe(1);
  });

  it("skips when the phrase is already inside a wiki-link", () => {
    const content = "See [[Notes|neural networks]] for details.";
    const s: LinkSuggestion = {
      phrase: "neural networks",
      target: "Neural Networks",
      reason: "x",
    };
    expect(applyLinkSuggestion(content, s)).toBe(content);
  });

  it("skips when the phrase is already inside a markdown link", () => {
    const content = "See [neural networks](https://x.com) for details.";
    const s: LinkSuggestion = {
      phrase: "neural networks",
      target: "X",
      reason: "y",
    };
    expect(applyLinkSuggestion(content, s)).toBe(content);
  });

  it("respects word boundaries (won't link a partial-word match)", () => {
    const content = "Cathedral Cats meow.";
    const s: LinkSuggestion = {
      phrase: "Cat",
      target: "Cat",
      reason: "z",
    };
    // "Cat" appears as a substring of "Cathedral" and "Cats" but not as a
    // standalone word — the function should leave the content alone.
    expect(applyLinkSuggestion(content, s)).toBe(content);
  });

  it("escapes regex metacharacters in the phrase", () => {
    const content = "Use map(x => x + 1) often.";
    const s: LinkSuggestion = {
      phrase: "map(x => x + 1)",
      target: "JS Map",
      reason: "code reference",
    };
    // The phrase contains regex specials (parens, plus, +) — the helper
    // must escape them and still produce a valid replacement.
    const out = applyLinkSuggestion(content, s);
    expect(out).toContain("[[JS Map|map(x => x + 1)]]");
  });
});
