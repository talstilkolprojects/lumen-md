/**
 * The Markdown syntax Lumen reads: CommonMark (remark-parse) plus these
 * extensions. One list shared by the preview pipeline and the conformance
 * suite (src/__tests__/mdConformance.test.ts), so the suite always tests the
 * syntax the app really parses. Transformers (soft breaks, wiki links,
 * admonitions, …) are not syntax and stay in pipeline.ts.
 */
import type { Preset } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";

export const markdownSyntax: Preset = {
  plugins: [[remarkFrontmatter, ["yaml"]], remarkGfm, remarkMath, remarkDirective],
};
