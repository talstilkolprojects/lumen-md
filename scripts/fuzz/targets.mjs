/**
 * The decoders the fuzzer runs (plan W1.27), one entry per format the app
 * reads from files, the clipboard, links or plugins.
 *
 *   load(root)  → a function taking one input string. It is called a million
 *                 times; anything it throws is a crash unless `expected(err)`
 *                 says that error is the decoder's documented way to refuse.
 *   gen         → the generator (scripts/fuzz/generators.ts).
 *   module      → the file the decoder lives in; when it is not on this
 *                 branch the target is reported as "not on this branch".
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const imp = (root, rel) => import(pathToFileURL(join(root, rel)).href);

export const TARGETS = [
  {
    name: "markdown",
    gen: "markdown",
    module: "src/renderer/remarkLumen.ts",
    about: "Markdown → HTML tree: the preview's remark/rehype chain (GFM, math, front matter, directives, wiki links, raw HTML + the allowlist sanitizer)",
    async load(root) {
      const [{ unified }, parse, gfm, math, fm, directive, rehype, raw, slug, { remarkLumen }, { rehypeSanitizeRaw }] = await Promise.all([
        import("unified"),
        import("remark-parse"),
        import("remark-gfm"),
        import("remark-math"),
        import("remark-frontmatter"),
        import("remark-directive"),
        import("remark-rehype"),
        import("rehype-raw"),
        import("rehype-slug"),
        imp(root, "src/renderer/remarkLumen.ts"),
        imp(root, "src/renderer/rehypeSanitizeRaw.ts"),
      ]);
      // As the preview does (src/renderer/pipeline.ts input()): blocks over the parser's bounds become raw text (plan W4.16).
      const { boundMarkdown } = await imp(root, "src/renderer/boundMarkdown.ts");
      const proc = unified()
        .use(parse.default)
        .use(gfm.default)
        .use(math.default)
        .use(fm.default, ["yaml", "toml"])
        .use(directive.default)
        .use(remarkLumen)
        .use(rehype.default, { allowDangerousHtml: true })
        .use(raw.default)
        .use(rehypeSanitizeRaw)
        .use(slug.default);
      return (s) => proc.runSync(proc.parse(boundMarkdown(s)));
    },
  },
  {
    name: "frontmatter",
    gen: "yaml",
    module: "src/renderer/pipeline.ts",
    about: "Front matter: the YAML block at the top of a note (extractFrontmatter's parser and options)",
    expected: (e) => e instanceof Error && !(e instanceof RangeError),
    async load() {
      const YAML = await import("yaml");
      // extractFrontmatter catches what YAML.parse throws for invalid input
      // (YAMLParseError, an unresolved alias's ReferenceError…): those are
      // refusals. Exhausting the stack or the heap is a crash.
      return (s) => YAML.parse(s);
    },
  },
  {
    name: "bibtex",
    gen: "bibtex",
    module: "src/data/bibtex.ts",
    about: "BibTeX blocks (references)",
    async load(root) {
      const { parseBibtex, formatEntry } = await imp(root, "src/data/bibtex.ts");
      return (s) => parseBibtex(s).forEach((e, i) => formatEntry(e, i + 1));
    },
  },
  {
    name: "json-doctor",
    gen: "json",
    module: "src/data/codeDoctor.ts",
    about: "JSON / JSONL diagnosis and repair (Code Doctor), and raw JSON found in notes",
    async load(root) {
      const m = await imp(root, "src/data/codeDoctor.ts");
      return (s) => {
        m.diagnoseJson(s);
        m.repairJson(s);
        m.diagnoseJsonl(s);
        m.detectRawJsonRegions(s);
      };
    },
  },
  {
    name: "json-records",
    gen: "json",
    module: "src/data/insights.ts",
    about: "JSON / JSONL datasets (Insights)",
    expected: (e) => e instanceof Error && /^JSONL parse error on line \d+/.test(e.message),
    async load(root) {
      const { parseJsonRecords, describeDataset } = await imp(root, "src/data/insights.ts");
      return (s) => describeDataset(parseJsonRecords(s));
    },
  },
  {
    name: "urls",
    gen: "url",
    module: "src/lib/urlSanitizer.ts",
    about: "Link and embed URLs: the sanitizer, embed detection and the CSP connect check",
    async load(root) {
      const [{ sanitizeUrl }, { detectEmbed }, { connectAllowedByCsp }] = await Promise.all([
        imp(root, "src/lib/urlSanitizer.ts"),
        imp(root, "src/data/embedDetect.ts"),
        imp(root, "src/lib/cspConnect.ts"),
      ]);
      const sources = ["'self'", "https://example.com", "wss://*.example.com", "http://localhost:*"];
      return (s) => {
        sanitizeUrl(s);
        detectEmbed(s);
        connectAllowedByCsp(s, sources);
      };
    },
  },
  {
    name: "text-direction",
    gen: "markdown",
    module: "src/lib/textDirection.ts",
    about: "The base direction of a note (Hebrew / Arabic / Latin)",
    async load(root) {
      const { markdownBaseDirection, firstRtlLanguage } = await imp(root, "src/lib/textDirection.ts");
      return (s) => {
        markdownBaseDirection(s);
        firstRtlLanguage(s);
      };
    },
  },
  // Formats whose decoders arrive with later tasks; each is fuzzed as soon
  // as its module is on the branch (add its `load` with the module).
  { name: "base", gen: "yaml", module: null, about: ".base database views (plan 4.11)", lands: "4.11" },
  { name: "excalidraw", gen: "json", module: null, about: ".excalidraw drawings (plan 4.19)", lands: "4.19" },
  { name: "pdf-annotations", gen: "json", module: null, about: "PDF annotations (plan 4.14)", lands: "4.14" },
  { name: "plugin-manifest", gen: "manifest", module: null, about: "Plugin manifests (plan 11.2)", lands: "11.2" },
];

/** Is the target's decoder on this branch? */
export const present = (t, root) => !!t.module && !!t.load && existsSync(join(root, t.module));
