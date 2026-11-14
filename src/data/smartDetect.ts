/**
 * Smart-insert detector — feed it ANY text and it returns the best fenced
 * markdown wrapping (or "leave it alone" for plain markdown).
 *
 * The detection runs as an ordered pipeline. Earlier matchers win, so put
 * the high-confidence narrow patterns (recognised embed URLs, fenced code)
 * before the broad fallbacks (looks-like-CSV, looks-like-code).
 *
 * Each detector returns `null` when it doesn't match, otherwise a
 * `Detection` object with the rendered fence and a human-readable label
 * for the dialog to display ("Detected: 📊 CSV table").
 */

import { detectEmbed } from "./embedDetect";
import { htmlToMarkdown } from "../storage/fileFormats";

export type DetectedKind =
  | "embed"
  | "url"
  | "html-preview"
  | "html-markdown"
  | "live-css"
  | "live-svg"
  | "live-glsl"
  | "math"
  | "mermaid"
  | "dot"
  | "plantuml"
  | "csv"
  | "tsv"
  | "json-table"
  | "json"
  | "sql"
  | "chart"
  | "database"
  | "geojson"
  | "abc"
  | "bibtex"
  | "code"
  | "markdown";

export interface Detection {
  kind: DetectedKind;
  /** Short human label for the UI badge ("📊 CSV table"). */
  label: string;
  /** The text already wrapped in the right fence — what to insert. */
  rendered: string;
  /** Detected language for code blocks (typescript, python, …). */
  codeLang?: string;
}

/* ─── Atomic detectors ──────────────────────────────────────────────── */

function tryEmbed(input: string): Detection | null {
  const trimmed = input.trim();
  if (trimmed.includes("\n")) return null;
  const platform = detectEmbed(trimmed);
  if (!platform) return null;
  return {
    kind: "embed",
    label: `🔗 ${platform} embed`,
    rendered: "```embed\n" + trimmed + "\n```",
  };
}

function tryBareUrl(input: string): Detection | null {
  const trimmed = input.trim();
  if (trimmed.includes("\n")) return null;
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return {
    kind: "url",
    label: "🔗 Link",
    rendered: `[${trimmed}](${trimmed})`,
  };
}

function tryHtml(input: string): Detection | null {
  const trimmed = input.trim();
  if (!/^</.test(trimmed) || !/<\/?[a-zA-Z][\s\S]*?>/.test(trimmed)) return null;
  // SVG-only → render via the dedicated, lighter Live-SVG block.
  if (/^<svg\b/i.test(trimmed) && /<\/svg>\s*$/i.test(trimmed)) {
    return {
      kind: "live-svg",
      label: "🖼️ SVG",
      rendered: "```live-svg\n" + trimmed + "\n```",
    };
  }
  // Interactive HTML (script/style/iframe/canvas/video/form) → live preview block.
  // Static markup → convert to markdown.
  if (/<(script|style|iframe|canvas|video|audio|form|button)\b/i.test(trimmed)) {
    return {
      kind: "html-preview",
      label: "🖼️ Interactive HTML",
      rendered: "```htmlpreview\n" + trimmed + "\n```",
    };
  }
  return {
    kind: "html-markdown",
    label: "🧾 HTML → Markdown",
    rendered: htmlToMarkdown(trimmed),
  };
}

/** GLSL fragment shader — looks for `void main()` + WebGL builtins. */
function tryGlsl(input: string): Detection | null {
  const trimmed = input.trim();
  if (
    /void\s+main\s*\(\s*\)\s*\{/.test(trimmed) &&
    /(gl_FragColor|gl_FragCoord|iTime|iResolution)/.test(trimmed)
  ) {
    return {
      kind: "live-glsl",
      label: "🌈 GLSL shader",
      rendered: "```live-glsl\n" + trimmed + "\n```",
    };
  }
  return null;
}

/** Pure CSS — body has selectors + property:value pairs but no HTML tags. */
function tryCss(input: string): Detection | null {
  const trimmed = input.trim();
  if (/<\w/.test(trimmed)) return null; // contains HTML — not pure CSS
  // Bail when this looks like real source code: keywords TS/JS/etc. ship.
  if (
    /\b(export|import|const|let|var|function|class|interface|return|async|await|public|private|protected|static)\b/.test(
      trimmed,
    )
  ) {
    return null;
  }
  // Selectors must start with one of: `.`, `#`, `*`, `&`, `:` (pseudo),
  // `@` (at-rule), or a known HTML tag name. This rejects type-soup
  // like "Foo { bar: string; }".
  const HTML_TAGS =
    "html|body|head|title|meta|link|main|section|article|nav|aside|header|footer|h[1-6]|p|div|span|a|img|ul|ol|li|table|tr|td|th|button|input|textarea|form|label|select|option|svg|canvas|video|audio|figure|figcaption|code|pre|blockquote|hr|br";
  const selectorRe = new RegExp(
    `^\\s*([.#*&@:]|(?:${HTML_TAGS})\\b)[^{]*\\{`,
    "m",
  );
  if (!selectorRe.test(trimmed)) return null;
  // Must contain at least one property-shaped declaration: a known CSS
  // property name followed by `:`.
  if (
    !/\b(color|background|padding|margin|border|font|width|height|display|position|top|left|right|bottom|flex|grid|gap|opacity|transform|transition|animation|content|overflow|cursor|text-[\w-]+|box-[\w-]+|border-[\w-]+|background-[\w-]+|font-[\w-]+|align-[\w-]+|justify-[\w-]+)\s*:/.test(
      trimmed,
    )
  ) {
    return null;
  }
  // Bias toward live-css when the rule count is small and there's no
  // `@import` / `@charset` (those are typically real stylesheets, not
  // demo snippets — keep them as code blocks via the code path).
  const ruleCount = (trimmed.match(/\}/g) ?? []).length;
  if (ruleCount > 0 && ruleCount <= 12 && !/^@(import|charset)/m.test(trimmed)) {
    return {
      kind: "live-css",
      label: "🎨 Live CSS",
      rendered: "```live-css\n" + trimmed + "\n```",
    };
  }
  return null;
}

function tryMath(input: string): Detection | null {
  const trimmed = input.trim();
  // $$...$$ display math, or LaTeX \begin{...}\end{...}
  if (/^\$\$[\s\S]+\$\$$/.test(trimmed)) {
    return { kind: "math", label: "∑ Math (display)", rendered: trimmed };
  }
  if (/^\\begin\{[a-z*]+\}[\s\S]+\\end\{[a-z*]+\}$/i.test(trimmed)) {
    return { kind: "math", label: "∑ Math (LaTeX)", rendered: `$$\n${trimmed}\n$$` };
  }
  // Looks like a single TeX expression: starts with \, has \frac/\sum/\int etc.
  if (/^\\[a-zA-Z]+/.test(trimmed) && /\\(frac|sum|int|sqrt|left|right|alpha|beta|gamma|theta|pi|infty)/i.test(trimmed)) {
    return { kind: "math", label: "∑ Math (TeX)", rendered: `$$\n${trimmed}\n$$` };
  }
  return null;
}

function tryMermaid(input: string): Detection | null {
  const trimmed = input.trim();
  if (
    /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|xychart-beta)\b/i.test(
      trimmed,
    )
  ) {
    return {
      kind: "mermaid",
      label: "🧜 Mermaid diagram",
      rendered: "```mermaid\n" + trimmed + "\n```",
    };
  }
  return null;
}

function tryDot(input: string): Detection | null {
  const trimmed = input.trim();
  if (/^(strict\s+)?(di)?graph(\s+\w+)?\s*\{/i.test(trimmed)) {
    return {
      kind: "dot",
      label: "🕸️ Graphviz",
      rendered: "```dot\n" + trimmed + "\n```",
    };
  }
  return null;
}

function tryPlantUml(input: string): Detection | null {
  const trimmed = input.trim();
  if (/^@startuml[\s\S]*@enduml\s*$/im.test(trimmed)) {
    return {
      kind: "plantuml",
      label: "🌱 PlantUML",
      rendered: "```plantuml\n" + trimmed + "\n```",
    };
  }
  return null;
}

function tryAbc(input: string): Detection | null {
  const trimmed = input.trim();
  // ABC notation always starts with one or more `<header>:value` lines, with
  // X: (tune number) being mandatory.
  if (/^X:\s*\d+/m.test(trimmed) && /^[KM]:/m.test(trimmed)) {
    return {
      kind: "abc",
      label: "🎼 Music notation (ABC)",
      rendered: "```abc\n" + trimmed + "\n```",
    };
  }
  return null;
}

function tryBibtex(input: string): Detection | null {
  const trimmed = input.trim();
  if (/^@(article|book|inproceedings|misc|phdthesis|techreport|incollection|inbook)\s*\{/i.test(trimmed)) {
    return {
      kind: "bibtex",
      label: "📚 BibTeX citation",
      rendered: "```bibtex\n" + trimmed + "\n```",
    };
  }
  return null;
}

function tryGeojson(input: string): Detection | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as { type?: string; features?: unknown };
    if (obj?.type === "FeatureCollection" || obj?.type === "Feature") {
      return {
        kind: "geojson",
        label: "🗺️ GeoJSON map",
        rendered: "```map\n" + trimmed + "\n```",
      };
    }
  } catch {
    /* why: not JSON */
  }
  return null;
}

function tryJsonTable(input: string): Detection | null {
  const trimmed = input.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    const obj = JSON.parse(trimmed);
    // Array of homogeneous objects → tabular.
    if (
      Array.isArray(obj) &&
      obj.length > 0 &&
      obj.every((r) => r && typeof r === "object" && !Array.isArray(r))
    ) {
      return {
        kind: "json-table",
        label: "📊 JSON table",
        rendered: "```json-table\n" + trimmed + "\n```",
      };
    }
    // Anything else valid JSON → raw fenced.
    return {
      kind: "json",
      label: "🧾 JSON",
      rendered: "```json\n" + JSON.stringify(obj, null, 2) + "\n```",
    };
  } catch {
    return null;
  }
}

function tryChartSpec(input: string): Detection | null {
  const trimmed = input.trim();
  // YAML / JSON ECharts spec — has xAxis / yAxis / series at top level.
  if (
    /^(xAxis|yAxis|series|title|tooltip)\s*:/im.test(trimmed) &&
    /^series\s*:/im.test(trimmed)
  ) {
    return {
      kind: "chart",
      label: "📈 ECharts spec",
      rendered: "```chart\n" + trimmed + "\n```",
    };
  }
  return null;
}

function tryDatabaseSpec(input: string): Detection | null {
  const trimmed = input.trim();
  // Database YAML — has `view:` (one of table/kanban/gallery/calendar) AND
  // either `type:` or `source:`. Picks up before the generic chart sniff.
  if (
    /^view\s*:\s*(table|kanban|gallery|calendar)\b/im.test(trimmed) &&
    /^(type|source)\s*:/im.test(trimmed)
  ) {
    return {
      kind: "database",
      label: "🗂️ Database view",
      rendered: "```database\n" + trimmed + "\n```",
    };
  }
  return null;
}

function trySql(input: string): Detection | null {
  if (
    /^\s*(create\s+(table|view)|insert\s+into|select\s+[\s\S]*\sfrom\s)/i.test(
      input,
    )
  ) {
    return {
      kind: "sql",
      label: "🗄️ SQL → table",
      rendered: "```sql\n" + input.trim() + "\n```",
    };
  }
  return null;
}

function tryCsvOrTsv(input: string): Detection | null {
  const lines = input.trim().split("\n");
  if (lines.length < 2) return null;
  // Sniff delimiter — prefer tab if any line contains one and doesn't have commas.
  const hasTabs = lines.every((l) => l.includes("\t"));
  const hasCommas = lines.every((l) => l.split(",").length >= 2);
  if (!hasTabs && !hasCommas) return null;
  // Make sure rows are roughly the same width.
  const delim = hasTabs ? "\t" : ",";
  const widths = lines.slice(0, 5).map((l) => l.split(delim).length);
  const minW = Math.min(...widths);
  const maxW = Math.max(...widths);
  if (minW < 2 || maxW - minW > 1) return null;
  return hasTabs
    ? {
        kind: "tsv",
        label: "📊 TSV table",
        rendered: "```tsv\n" + input.trim() + "\n```",
      }
    : {
        kind: "csv",
        label: "📊 CSV table",
        rendered: "```csv\n" + input.trim() + "\n```",
      };
}

function tryCode(input: string): Detection | null {
  const trimmed = input.trim();
  // Already fenced — leave alone.
  if (/^```/.test(trimmed)) return null;
  // Markdown indicators present — not code.
  if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/m.test(trimmed)) return null;
  const lang = guessLanguage(trimmed);
  if (!lang) return null;
  return {
    kind: "code",
    label: `💻 ${lang.toUpperCase()} code`,
    rendered: "```" + lang + "\n" + trimmed + "\n```",
    codeLang: lang,
  };
}

function guessLanguage(text: string): string | null {
  if (/^(import|export|const|let|var)\s+\w/.test(text) && /[{};=]/.test(text)) {
    return /:\s*(string|number|boolean)|interface\s+\w/.test(text) ? "ts" : "js";
  }
  if (/^def\s+\w+\s*\(/.test(text) || /^import\s+\w+/.test(text)) return "py";
  if (/^(public|private|protected)\s+(class|interface|static)\s/.test(text)) return "java";
  if (/^package\s+\w/.test(text) && /func\s+\w/.test(text)) return "go";
  if (/^fn\s+\w+\s*\(/.test(text) && /->/.test(text)) return "rs";
  if (/^#include\s*<\w/.test(text)) return "cpp";
  if (/^<\?php/.test(text)) return "php";
  if (/^(class|module)\s+\w+\s*$/m.test(text) && /\bend\b/.test(text)) return "ruby";
  if (/^\s*(if|for|while)\s*\(.+\)\s*\{/.test(text) && /[{};]/.test(text)) return "js";
  if (/^\$\w+\s*=/m.test(text)) return "shell";
  if (/^FROM\s+\w/m.test(text) && /^RUN\s/m.test(text)) return "dockerfile";
  return null;
}

/* ─── Public API ────────────────────────────────────────────────────── */

const PIPELINE: ((s: string) => Detection | null)[] = [
  tryEmbed,
  tryBareUrl,
  tryMath,
  tryMermaid,
  tryDot,
  tryPlantUml,
  tryAbc,
  tryBibtex,
  tryGeojson,
  // Database must beat chart-spec sniff because both can have `series:`-shaped
  // YAML. Database additionally requires `view:` so it's the more specific.
  tryDatabaseSpec,
  tryChartSpec,
  trySql,
  tryJsonTable,
  // GLSL before HTML — `void main()` + GLSL builtins are unambiguous;
  // checking it first means a stray <something> in a comment doesn't
  // misroute the snippet to htmlpreview.
  tryGlsl,
  tryHtml,
  // Pure CSS after HTML so a snippet that mixes `<style>…</style>` with
  // markup still gets picked up as html-preview.
  tryCss,
  tryCsvOrTsv,
  tryCode,
];

/**
 * Run the pipeline and return the best detection. Falls back to a
 * "markdown" no-op when nothing matches.
 */
export function smartDetect(input: string): Detection {
  if (!input.trim()) {
    return { kind: "markdown", label: "📝 Markdown", rendered: input };
  }
  for (const fn of PIPELINE) {
    const m = fn(input);
    if (m) return m;
  }
  return { kind: "markdown", label: "📝 Markdown", rendered: input };
}

/** All detectors as a (kind, label) list — useful for the dialog dropdown. */
export const ALL_KINDS: { kind: DetectedKind; label: string }[] = [
  { kind: "markdown", label: "📝 Markdown" },
  { kind: "embed", label: "🔗 Embed URL" },
  { kind: "url", label: "🔗 Link" },
  { kind: "html-preview", label: "🖼️ Interactive HTML" },
  { kind: "html-markdown", label: "🧾 HTML → Markdown" },
  { kind: "live-css", label: "🎨 Live CSS" },
  { kind: "live-svg", label: "🖼️ SVG" },
  { kind: "live-glsl", label: "🌈 GLSL shader" },
  { kind: "math", label: "∑ Math (TeX)" },
  { kind: "mermaid", label: "🧜 Mermaid diagram" },
  { kind: "dot", label: "🕸️ Graphviz" },
  { kind: "plantuml", label: "🌱 PlantUML" },
  { kind: "csv", label: "📊 CSV table" },
  { kind: "tsv", label: "📊 TSV table" },
  { kind: "json-table", label: "📊 JSON table" },
  { kind: "json", label: "🧾 JSON" },
  { kind: "sql", label: "🗄️ SQL → table" },
  { kind: "chart", label: "📈 ECharts spec" },
  { kind: "database", label: "🗂️ Database view" },
  { kind: "geojson", label: "🗺️ GeoJSON map" },
  { kind: "abc", label: "🎼 Music (ABC)" },
  { kind: "bibtex", label: "📚 BibTeX" },
  { kind: "code", label: "💻 Code (auto-language)" },
];

/** Re-render the input under a forced kind — used when the user overrides
 *  the auto-detection. */
export function renderAs(input: string, kind: DetectedKind, codeLang = ""): string {
  if (!input.trim()) return "";
  switch (kind) {
    case "markdown":
      return input;
    case "embed":
      return "```embed\n" + input.trim() + "\n```";
    case "url":
      return `[${input.trim()}](${input.trim()})`;
    case "html-preview":
      return "```htmlpreview\n" + input + "\n```";
    case "html-markdown":
      return htmlToMarkdown(input);
    case "live-css":
      return "```live-css\n" + input.trim() + "\n```";
    case "live-svg":
      return "```live-svg\n" + input.trim() + "\n```";
    case "live-glsl":
      return "```live-glsl\n" + input.trim() + "\n```";
    case "math":
      return `$$\n${input.trim()}\n$$`;
    case "mermaid":
      return "```mermaid\n" + input.trim() + "\n```";
    case "dot":
      return "```dot\n" + input.trim() + "\n```";
    case "plantuml":
      return "```plantuml\n" + input.trim() + "\n```";
    case "csv":
      return "```csv\n" + input.trim() + "\n```";
    case "tsv":
      return "```tsv\n" + input.trim() + "\n```";
    case "json-table":
      return "```json-table\n" + input.trim() + "\n```";
    case "json":
      return "```json\n" + input.trim() + "\n```";
    case "sql":
      return "```sql\n" + input.trim() + "\n```";
    case "chart":
      return "```chart\n" + input.trim() + "\n```";
    case "database":
      return "```database\n" + input.trim() + "\n```";
    case "geojson":
      return "```map\n" + input.trim() + "\n```";
    case "abc":
      return "```abc\n" + input.trim() + "\n```";
    case "bibtex":
      return "```bibtex\n" + input.trim() + "\n```";
    case "code":
      return "```" + (codeLang || "") + "\n" + input.replace(/\n$/, "") + "\n```";
  }
}
