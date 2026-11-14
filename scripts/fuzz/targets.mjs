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
  // The four formats W1.27 registered ahead of their tasks (4.11, 4.19,
  // 4.14, 11.2), now that their modules are on the train (W4.16).
  {
    name: "base",
    gen: "yaml",
    module: "src/views/bases/base.ts",
    about: ".base database views (plan 4.11): YAML parse, validation and re-serialisation",
    async load(root) {
      const { parseBase, setViewSort } = await imp(root, "src/views/bases/base.ts");
      return (s) => {
        parseBase(s);
        setViewSort(s, 0, [{ property: "file.name", direction: "ASC" }]);
      };
    },
  },
  {
    name: "excalidraw",
    gen: "json",
    module: "src/canvas/excalidrawFile.ts",
    about: ".excalidraw drawings (plan 4.19): envelope and element validation, then serialise",
    // parseExcalidrawFile refuses a file it can't open with ExcalidrawFileError (documented).
    expected: (e) => e instanceof Error && e.name === "ExcalidrawFileError",
    async load(root) {
      const { parseExcalidrawFile, serializeExcalidrawFile } = await imp(root, "src/canvas/excalidrawFile.ts");
      return (s) => serializeExcalidrawFile(parseExcalidrawFile(s));
    },
  },
  {
    name: "pdf-annotations",
    gen: "markdown",
    module: "src/pdf/annotations.ts",
    about: "PDF annotations (plan 4.14): the companion note's annotation block, PDF #fragments and quote anchoring",
    async load(root) {
      const m = await imp(root, "src/pdf/annotations.ts");
      return (s) => {
        const list = m.parseAnnotationsNote(s);
        m.readAnnotationsNote(s);
        m.parsePdfFragment(s.slice(0, 200));
        for (const a of list.slice(0, 5)) m.anchorAnnotation(a, s);
        m.findAll(s, s.slice(0, 3));
      };
    },
  },
  {
    name: "plugin-manifest",
    gen: "manifest",
    module: "src/plugins/runtime/manifest.ts",
    about: "Plugin manifests (plan 11.2): parse and validate, capabilities and network origins",
    // parseManifest refuses an invalid manifest with ManifestError (documented).
    expected: (e) => e instanceof Error && e.name === "ManifestError",
    async load(root) {
      const { parseManifest, networkOrigin } = await imp(root, "src/plugins/runtime/manifest.ts");
      return (s) => {
        try {
          parseManifest(JSON.parse(s));
        } catch (e) {
          if (e instanceof SyntaxError) parseManifest(s);
          else throw e;
        }
        networkOrigin(s.slice(0, 300));
      };
    },
  },
];

/** Is the target's decoder on this branch? */
export const present = (t, root) => !!t.module && !!t.load && existsSync(join(root, t.module));
