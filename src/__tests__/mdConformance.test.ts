/**
 * Markdown conformance (W1.2): Lumen's Markdown syntax against the official
 * CommonMark 0.31.2 and GFM 0.29 spec examples (vendored, unmodified, in
 * fixtures/md-spec/ with their source, commit and CC BY-SA 4.0 notice).
 *
 * The renderer is the app's own: remark-parse plus the `markdownSyntax`
 * preset the preview pipeline uses (frontmatter, GFM, math, directives),
 * then remark-rehype with raw HTML passed through. Lumen's transformers
 * (soft breaks as <br>, wiki links, admonitions, …) are product choices on
 * top of the syntax, so they are scored separately and not gated.
 *
 * Gates: at least 99% of CommonMark and 98% of GFM. The suite prints and
 * writes (test-results/md-conformance/) every failing example, by number.
 * `npm run md:conformance` runs this file with the round-trip suite.
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { markdownSyntax } from "../renderer/syntax";
import { remarkBreaks } from "../renderer/remarkLumen";
import cmSpec from "./fixtures/md-spec/commonmark-0.31.2.txt?raw";
import gfmSpec from "./fixtures/md-spec/gfm-0.29.txt?raw";
import {
  domFragmentParser,
  hastToHtml,
  normalizeHtml,
  parseSpec,
  passRate,
  runSuite,
  type SuiteResult,
} from "./helpers/mdSpec";

const parse = domFragmentParser(document);

function renderer(withBreaks: boolean) {
  const p = withBreaks
    ? unified().use(remarkParse).use(markdownSyntax).use(remarkBreaks).use(remarkRehype, { allowDangerousHtml: true })
    : unified().use(remarkParse).use(markdownSyntax).use(remarkRehype, { allowDangerousHtml: true });
  return (md: string) => hastToHtml(p.runSync(p.parse(md)) as never);
}

const core = (() => {
  const p = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true });
  return (md: string) => hastToHtml(p.runSync(p.parse(md)) as never);
})();

const cm = parseSpec(cmSpec);
const gfmAll = parseSpec(gfmSpec);

/**
 * The GFM spec is pinned to CommonMark 0.29. Where CommonMark 0.31.2 changed
 * the expected output of the very same input (the emphasis rules, mostly),
 * the parser follows the newer spec, so those GFM examples are left out of
 * the GFM score (listed in the report as "superseded").
 */
const cmHtml = new Map(cm.map((e) => [e.markdown, normalizeHtml(e.html, parse)]));
const superseded = gfmAll.filter((e) => {
  const c = cmHtml.get(e.markdown);
  return c !== undefined && c !== normalizeHtml(e.html, parse);
});
const gfm = gfmAll.map((e) => (superseded.includes(e) ? { ...e, extension: "superseded" } : e));

/**
 * Where Lumen differs from the spec on purpose. Each one is a product choice,
 * documented in docs/src/content/docs/editor/markdown-fidelity.md. The suite fails on any
 * failing example not listed here, so a new deviation has to be explained.
 */
const FRONTMATTER = "a leading `---` block is YAML frontmatter (metadata), not a thematic break and text";
const AUTOLINK = "GFM autolink literals are on everywhere, so a bare URL or email address in a plain CommonMark example becomes a link";
const KNOWN_DEVIATIONS: Record<string, Record<number, string>> = {
  "CommonMark 0.31.2": {
    96: FRONTMATTER,
    602: AUTOLINK,
    608: AUTOLINK,
    609: AUTOLINK,
    611: AUTOLINK,
    612: AUTOLINK,
  },
  "GFM 0.29": {
    66: FRONTMATTER,
    610: AUTOLINK,
    616: AUTOLINK,
    619: AUTOLINK,
    620: AUTOLINK,
    628: "`ftp://` is not an autolink literal (micromark follows github.com, which dropped it)",
    652: "the parser keeps disallowed raw HTML; the preview sanitizes raw HTML afterwards (rehypeSanitizeRaw), which removes these tags",
  },
};

const results: SuiteResult[] = [];

async function writeReport() {
  try {
    const fs = await import("node:fs");
    const dir = "test-results/md-conformance";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(results, null, 2));
    const lines = ["# Markdown conformance", ""];
    for (const r of results) {
      lines.push(`## ${r.name}: ${r.passed}/${r.total} (${(passRate(r) * 100).toFixed(2)}%)`, "");
      for (const f of r.failed) {
        lines.push(`- Example ${f.example} (${f.section}, spec line ${f.line})`);
        lines.push("  - expected: `" + f.expected.replace(/`/g, "\\`") + "`");
        lines.push("  - actual: `" + f.actual.replace(/`/g, "\\`") + "`");
      }
      lines.push("");
    }
    fs.writeFileSync(`${dir}/report.md`, lines.join("\n"));
  } catch {
    // No file system (browser runner): the console summary is enough.
  }
}

/** Failing examples with no entry in KNOWN_DEVIATIONS, with what went wrong. */
function unexplained(r: SuiteResult): string[] {
  const known = KNOWN_DEVIATIONS[r.name] ?? {};
  return r.failed
    .filter((f) => !(f.example in known))
    .map((f) => `Example ${f.example} (${f.section}): ${JSON.stringify(f.markdown)} expected ${f.expected} got ${f.actual}`);
}

function summary(r: SuiteResult): string {
  const ids = r.failed.map((f) => f.example).join(", ");
  return `${r.name}: ${r.passed}/${r.total} (${(passRate(r) * 100).toFixed(2)}%)${ids ? `; failing: ${ids}` : ""}`;
}

describe("Markdown conformance", () => {
  it("reads every example of the vendored spec files", () => {
    // The counts upstream prints; a changed count means a changed file.
    expect(cm.length).toBe(652);
    expect(gfmAll.length).toBe(672);
    expect(gfmAll.filter((e) => e.extension === "disabled").length).toBe(2);
    console.log(`GFM examples superseded by CommonMark 0.31.2: ${superseded.map((e) => e.example).join(", ")}`);
    // The emphasis rule changes of 0.30/0.31; a much larger number means the files went out of step.
    expect(superseded.length).toBeLessThanOrEqual(15);
  });

  it("passes at least 99% of CommonMark 0.31.2", () => {
    const r = runSuite("CommonMark 0.31.2", cm, renderer(false), parse);
    results.push(r);
    console.log(summary(r));
    expect(unexplained(r)).toEqual([]);
    expect(passRate(r)).toBeGreaterThanOrEqual(0.99);
  });

  it("passes at least 98% of GFM 0.29", () => {
    // `disabled` examples are the two task-list ones upstream skips too.
    const r = runSuite("GFM 0.29", gfm, renderer(false), parse, new Set(["disabled", "superseded"]));
    results.push(r);
    console.log(summary(r));
    expect(unexplained(r)).toEqual([]);
    expect(passRate(r)).toBeGreaterThanOrEqual(0.98);
  });

  it("scores the plain CommonMark parser and the preview's soft breaks (reported, not gated)", async () => {
    const c = runSuite("CommonMark 0.31.2, parser without extensions", cm, core, parse);
    const b = runSuite("CommonMark 0.31.2, with the preview's soft line breaks", cm, renderer(true), parse);
    results.push(c, b);
    console.log(summary(c));
    console.log(`${b.name}: ${b.passed}/${b.total}`);
    // The plain parser is micromark, which is fully compliant.
    expect(passRate(c)).toBeGreaterThanOrEqual(0.99);
    await writeReport();
  });
});
