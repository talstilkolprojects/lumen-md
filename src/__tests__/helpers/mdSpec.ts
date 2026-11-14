/**
 * Helpers for the Markdown conformance suite (W1.2).
 *
 * `parseSpec` reads the official spec test format: the examples in
 * CommonMark's `spec.txt` and the GFM spec, each one a block fenced by
 * 32 backticks plus `example`, with the Markdown and the expected HTML
 * split by a line holding a single `.`. `→` stands for a tab.
 *
 * `normalizeHtml` puts two HTML strings into one canonical form before they are
 * compared, the same way the spec's own `normalize.py` does: it parses the HTML
 * (so entities, attribute quoting and `<br />` and `<br>` agree), sorts the
 * attributes, and collapses whitespace outside `<pre>`, dropping it next to
 * block-level tags.
 */

export interface SpecExample {
  /** 1-based number, as the spec prints it ("Example 42"). */
  example: number;
  section: string;
  markdown: string;
  html: string;
  /** The word after `example` in the fence (`table`, `strikethrough`, `disabled`, …). */
  extension: string;
  /** 1-based line of the opening fence in the spec file. */
  line: number;
}

const FENCE = "`".repeat(32);

export function parseSpec(text: string): SpecExample[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: SpecExample[] = [];
  let section = "";
  let state: "text" | "md" | "html" = "text";
  let md: string[] = [];
  let html: string[] = [];
  let extension = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (state === "text") {
      if (l.startsWith(FENCE + " example")) {
        state = "md";
        md = [];
        html = [];
        extension = l.slice(FENCE.length + " example".length).trim();
        start = i + 1;
      } else {
        const h = /^#{1,6} +(.+?)\s*$/.exec(l);
        if (h) section = h[1];
      }
    } else if (state === "md") {
      if (l === ".") state = "html";
      else md.push(l);
    } else if (l === FENCE) {
      out.push({
        example: out.length + 1,
        section,
        markdown: untab(md.join("\n") + (md.length ? "\n" : "")),
        html: untab(html.join("\n") + (html.length ? "\n" : "")),
        extension,
        line: start,
      });
      state = "text";
    } else {
      html.push(l);
    }
  }
  return out;
}

function untab(s: string): string {
  return s.replace(/→/g, "\t");
}

const BLOCK = new Set(
  (
    "address article aside blockquote body caption center col colgroup dd details dialog dir div dl dt " +
    "fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link " +
    "main menu menuitem meta nav noframes ol optgroup option p param pre section source summary table " +
    "tbody td tfoot th thead title tr track ul"
  ).split(" "),
);
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

/** Parse an HTML fragment into nodes. Each environment passes its own DOM. */
export type FragmentParser = (html: string) => ArrayLike<Node>;

export function domFragmentParser(doc: Document): FragmentParser {
  return (html) => {
    const t = doc.createElement("template");
    t.innerHTML = html;
    return t.content.childNodes;
  };
}

function esc(s: string, attr: boolean): string {
  let r = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (attr) r = r.replace(/"/g, "&quot;");
  return r;
}

/** Canonical HTML for comparison. Two renderings are equal if their canonical forms are equal. */
export function normalizeHtml(html: string, parse: FragmentParser): string {
  const parts: string[] = [];
  const walk = (nodes: ArrayLike<Node>, inPre: boolean) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 3) {
        const v = n.nodeValue ?? "";
        parts.push(inPre ? esc(v, false) : esc(v.replace(/\s+/g, " "), false));
      } else if (n.nodeType === 8) {
        parts.push(`<!--${n.nodeValue ?? ""}-->`);
      } else if (n.nodeType === 1) {
        const el = n as Element;
        const tag = el.localName;
        const attrs = Array.from(el.attributes)
          .map((a) => [a.name, a.value] as const)
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([k, v]) => ` ${k}="${esc(v, true)}"`)
          .join("");
        const block = BLOCK.has(tag);
        if (block) parts.push("\u0000");
        parts.push(`<${tag}${attrs}>`);
        if (block) parts.push("\u0000");
        const kids = tag === "template" ? (el as HTMLTemplateElement).content.childNodes : el.childNodes;
        walk(kids, inPre || tag === "pre");
        if (!VOID.has(tag)) {
          if (block) parts.push("\u0000");
          parts.push(`</${tag}>`);
          if (block) parts.push("\u0000");
        }
      }
    }
  };
  walk(parse(html), false);
  // Whitespace next to a block-level tag carries no meaning; drop it.
  return parts
    .join("")
    .replace(/ ?\u0000 ?/g, "\u0000")
    .replace(/\u0000+/g, "")
    .trim();
}

export interface SuiteResult {
  name: string;
  total: number;
  passed: number;
  skipped: number;
  failed: { example: number; section: string; line: number; markdown: string; expected: string; actual: string }[];
  bySection: Record<string, { total: number; passed: number }>;
}

/** Run a renderer over the examples and score it. Examples whose extension is in `skip` do not count. */
export function runSuite(
  name: string,
  examples: SpecExample[],
  render: (md: string) => string,
  parse: FragmentParser,
  skip: ReadonlySet<string> = new Set(["disabled"]),
): SuiteResult {
  const res: SuiteResult = { name, total: 0, passed: 0, skipped: 0, failed: [], bySection: {} };
  for (const ex of examples) {
    if (skip.has(ex.extension)) {
      res.skipped++;
      continue;
    }
    res.total++;
    const sec = (res.bySection[ex.section] ??= { total: 0, passed: 0 });
    sec.total++;
    let actual: string;
    try {
      actual = render(ex.markdown);
    } catch (e) {
      actual = `[threw] ${e instanceof Error ? e.message : String(e)}`;
    }
    const want = normalizeHtml(ex.html, parse);
    const got = normalizeHtml(actual, parse);
    if (want === got) {
      res.passed++;
      sec.passed++;
    } else {
      res.failed.push({
        example: ex.example,
        section: ex.section,
        line: ex.line,
        markdown: ex.markdown,
        expected: want,
        actual: got,
      });
    }
  }
  return res;
}

export function passRate(r: SuiteResult): number {
  return r.total === 0 ? 0 : r.passed / r.total;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  content?: HastNode;
}

function attrName(prop: string): string {
  if (prop === "className") return "class";
  if (prop === "htmlFor") return "for";
  if (/^(data|aria)[A-Z]/.test(prop)) return prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  return prop.toLowerCase();
}

/**
 * HTML for a hast tree as remark-rehype builds it, with `raw` nodes (HTML
 * written in the Markdown) passed through unchanged, which is what the spec
 * expects. Small on purpose: the output is normalized by the DOM afterwards,
 * so it only has to be correct, not canonical.
 */
export function hastToHtml(node: HastNode): string {
  switch (node.type) {
    case "root":
      return (node.children ?? []).map(hastToHtml).join("");
    case "text":
      return esc(node.value ?? "", false);
    case "raw":
      return node.value ?? "";
    case "comment":
      return `<!--${node.value ?? ""}-->`;
    case "element": {
      const tag = node.tagName ?? "div";
      let attrs = "";
      for (const [k, v] of Object.entries(node.properties ?? {})) {
        if (v === false || v === null || v === undefined) continue;
        const val = v === true ? "" : Array.isArray(v) ? v.join(" ") : String(v);
        attrs += ` ${attrName(k)}="${esc(val, true)}"`;
      }
      if (VOID.has(tag)) return `<${tag}${attrs}>`;
      const kids = node.content ? hastToHtml(node.content) : (node.children ?? []).map(hastToHtml).join("");
      return `<${tag}${attrs}>${kids}</${tag}>`;
    }
    default:
      return "";
  }
}
