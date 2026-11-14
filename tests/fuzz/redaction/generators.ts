/**
 * The redaction fuzz generators (plan W8.8), in one place: every generator a
 * review wrote to look for "the preview shades it, the export keeps it" leaks.
 * Each one is kept as its review wrote it, so a seed it printed names the same
 * note here.
 *
 * - `tags` (review F-8, #473): `<redact>` tag variants and the HTML that changes
 *   how a tag is read (comments, attributes, raw-text elements, CDATA).
 * - `blocks` (review 6, rr6/r473-md-fuzz.mjs): notes built from Markdown
 *   blocks (paragraphs, headings, quotes and lists two deep, fences, indented
 *   code, math, tables, HTML blocks) with marks in random places.
 * - `footnotes` (review 8, RR8-473-2): `blocks` with footnote definitions and
 *   references and CriticMarkup suggestions dropped between the blocks.
 * - `containers` (review 8, rr8 and R6 r473-fuzz3): a recursive CommonMark
 *   container grammar (quotes and list items four deep, lazy continuation,
 *   tab indents), all seven HTML block kinds, setext headings, reference
 *   definitions, footnotes, math, directives, GFM tables, CriticMarkup and CRLF.
 *
 * Every text run carries a unique token (see `TOKEN` in oracle.ts), so a leak
 * names exactly what the export kept.
 */

export type Rng = () => number;

/** mulberry32: the PRNG of the F-8 and review 8 generators. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Review 6's PRNG, kept as written so its seeds name the same notes. */
export function rng6(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}

const pickOf = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

// ---------------------------------------------------------------- tags (F-8)

const NAMES = ["redact", "REDACT", "Redact", "rEdAcT"];
const AFTER = ["", " ", "\t", "\n", "\f", "\r", "/", " /", "  "];
const ATTRS = ["", ' class="x"', " id=1", " title='a>b'", ' title="a>b"', " a=b>c", " x=`y`", ' data-x="</redact>"', " a", ' a="', " a='", " /x", " =x"];
const CLOSERS = ["</redact>", "</REDACT>", "</redact >", "</redact\t>", "</redact foo>", "</redact/>", "</redact x='>'>", "</ redact>", "</redact", "</redactx>", "</redac>"];
/** Constructs that change how what follows them is read. `@` is where a closing tag variant goes. */
const WRAPS = [
  "<!-- @ -->", "<!--@-->", "<!-->@", "<!--->@", "<!-- @", "<!--- @ --->", "<!@>", "<?@?>",
  '<a title="@">', "<a title='@'>", "<a title=@>", '<img alt="@">',
  "<script>@</script>", "<style>@</style>", "<textarea>@</textarea>", "<title>@</title>", "<xmp>@</xmp>",
  "<noembed>@</noembed>", "<noframes>@</noframes>", "<iframe>@</iframe>",
  "<svg><![CDATA[@]]></svg>", "<math><![CDATA[@]]></math>", "<svg><title>@</title></svg>",
  "`@`", "\\@", "&lt;@", "<p>@</p>", "<table><tr><td>@</td></tr></table>", "<b>@</b>", "@",
];

function openTag(r: Rng): string {
  const after = pickOf(r, AFTER);
  const attrs = after === "" || after.endsWith("/") ? "" : pickOf(r, ATTRS);
  return `<${pickOf(r, NAMES)}${after}${attrs}${r() < 0.85 ? ">" : ""}`;
}

/** One F-8 case: text runs, each with its own `TK<n>Q` token, around marks and wrapped closing variants. */
export function tagCase(r: Rng): string {
  let n = 0;
  const tok = () => `TK${n++}Q`;
  let md = tok();
  const parts = 1 + Math.floor(r() * 4);
  for (let p = 0; p < parts; p++) {
    md += ` ${openTag(r)}${tok()}`;
    const inner = Math.floor(r() * 3);
    for (let k = 0; k < inner; k++) {
      const what = r();
      if (what < 0.5) md += pickOf(r, WRAPS).replace("@", pickOf(r, CLOSERS)) + tok();
      else if (what < 0.7) md += `${openTag(r)}${tok()}`;
      else md += (r() < 0.5 ? "\n\n" : " ") + tok();
    }
    if (r() < 0.8) md += pickOf(r, CLOSERS);
    md += ` ${tok()}`;
  }
  return md;
}

// ------------------------------------------------------- blocks (review 6)

/** Review 6's note of Markdown blocks. `T` makes the next token. */
export function markdownNote(r: Rng, T: () => string): string {
  const one = <X,>(a: readonly X[]): X => a[Math.floor(r() * a.length)];
  const OPEN = () => one(["<redact>", "<REDACT>", "<redact class=x>"]);
  const CLOSE = () => one(["</redact>", "</REDACT>", "</redact >"]);
  const inline = () => {
    const parts: string[] = [];
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) parts.push(one([T, T, T, OPEN, CLOSE, () => "`" + CLOSE() + "`", () => "*" + T() + "*", () => `[${T()}](x)`])());
    return parts.join(" ");
  };
  const codeBody = () => one([() => CLOSE(), () => T() + " " + CLOSE(), () => OPEN(), () => T()])();
  const leaf = (pre: string, cont: string): string[] =>
    one([
      () => [pre + inline()],
      () => [pre + "# " + inline()],
      () => [pre + "```", cont + codeBody(), cont + "```"],
      () => [pre + "~~~ js", cont + codeBody(), cont + "~~~"],
      () => [pre + "    " + codeBody()],
      () => [pre + "$$", cont + codeBody(), cont + "$$"],
      () => [pre + OPEN()],
      () => [pre + CLOSE()],
      () => [pre + "| a | b |", cont + "| - | - |", cont + `| ${T()} ${one(["", CLOSE()])} | ${T()} |`],
      () => [pre + "<div>", cont + T() + " " + one(["", CLOSE()]), cont + "</div>"],
    ])();
  const block = (depth = 0): string[] => {
    const kind = depth < 2 ? one(["leaf", "leaf", "quote", "list", "olist"]) : "leaf";
    if (kind === "leaf") return leaf("", "");
    if (kind === "quote") return block(depth + 1).map((l) => "> " + l);
    const marker = kind === "list" ? "- " : "1. ";
    const pad = " ".repeat(marker.length);
    return block(depth + 1).map((l, i) => (i === 0 ? marker : pad) + l);
  };
  const blocks: string[] = [];
  const n = 2 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) blocks.push(block().join("\n"));
  return blocks.map((b, i) => (i ? one(["\n\n", "\n\n", "\n"]) : "") + b).join("");
}

/** Review 8's mix: a review 6 note with footnotes and suggestions dropped between its blocks. */
export function footnoteNote(r: Rng, T: () => string): string {
  const one = <X,>(a: readonly X[]): X => a[Math.floor(r() * a.length)];
  const MARK = () => one(["<redact>", "</redact>", "<redact class=x>", "</REDACT>"]);
  const blocks = markdownNote(r, T).split("\n\n");
  const extra = 1 + Math.floor(r() * 3);
  for (let e = 0; e < extra; e++) {
    const n = 1 + Math.floor(r() * 3);
    const at = Math.floor(r() * (blocks.length + 1));
    blocks.splice(at, 0, one([
      () => `[^${n}]: ${T()} ${one(["", MARK()])} ${T()}`,
      () => `${T()}[^${n}] ${T()}`,
      () => `${T()} <span title={>>${T()}<<} ${MARK()} ${T()}`,
      () => `${T()} {~~${T()}~>${MARK()}~~} ${T()}`,
      () => `- ${T()} [^${n}]\n  [^${n}]: ${T()}`,
    ])());
  }
  return blocks.join("\n\n");
}

// ------------------------------------------------ containers (review 8, fuzz3)

export interface ContainerOptions {
  /** Leave CriticMarkup out (a leak that needs it is a different class). */
  noCritic?: boolean;
  /** Leave footnotes out. */
  noFoot?: boolean;
}

/** Review 8's container grammar (`r473-fuzz3.test.ts` `gen`), tokens `Z<n>Z`. */
export function containerNote(r: Rng, opts: ContainerOptions = {}): string {
  const noCritic = !!opts.noCritic;
  const FOOT = !opts.noFoot;
  let tok = 0;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const chance = (p: number) => r() < p;
  const word = () => `Z${++tok}Z`;
  const words = (n = 1 + Math.floor(r() * 3)) => Array.from({ length: n }, word).join(" ");
  const OPEN = ["<redact>", "<redact>", "<REDACT>", "<redact >", "<redact\tclass=x>", "<redact/>"];
  const CLOSE = ["</redact>", "</redact>", "</REDACT>", "</redact >", "</redact\n>"];
  const mark = () => (chance(0.5) ? pick(OPEN) : pick(CLOSE));
  const critic = () =>
    noCritic ? words(1) : pick([`{>>${words(1)}<<}`, `{~~${words(1)}~>${words(1)}~~}`, `{++${words(1)}++}`, `{--${words(1)}--}`, `{==${words(1)}==}`, `{>>${mark()}<<}`, `{++${mark()}++}`]);
  const attrVal = () => pick([`"${words(1)}"`, `'${mark()}'`, `"a>b"`, words(1), `x${noCritic ? "" : "{>>c<<}"}`, `{~~a~>b~~}`, `"${mark()}"`]);
  const tag = () => pick(["span", "b", "i", "a", "div", "p", "em", "sup", "section", "details", "summary", "table", "td", "li", "ul", "kbd", "u"]);
  function inline(): string {
    const parts: string[] = [];
    const n = 1 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const k = r();
      if (k < 0.25) parts.push(words());
      else if (k < 0.42) parts.push(mark());
      else if (k < 0.47) parts.push("`" + pick([words(1), mark(), "<b>"]) + "`");
      else if (k < 0.51) parts.push("$" + pick([words(1), mark(), "a<b"]) + "$");
      else if (k < 0.55) parts.push(`[${words(1)}](${pick(["/u", "</redact>", "<a b>"])} "${pick([words(1), mark()])}")`);
      else if (k < 0.58) parts.push(`![${pick([words(1), mark(), "<b>" + words(1)])}](/i.png)`);
      else if (k < 0.66) parts.push(`<${tag()}${chance(0.6) ? ` title=${attrVal()}` : ""}>`);
      else if (k < 0.71) parts.push(`</${tag()}>`);
      else if (k < 0.74) parts.push(`<!-- ${pick([words(1), mark()])} -->`);
      else if (k < 0.78) parts.push(!FOOT ? words(1) : `[^${1 + Math.floor(r() * 3)}]`);
      else if (k < 0.82) parts.push(`:${pick(["x", "note", "abbr"])}[${pick([words(1), mark(), "<b>" + words(1)])}]${chance(0.4) ? `{t="${mark()}"}` : ""}`);
      else if (k < 0.9) parts.push(critic());
      else if (k < 0.93) parts.push(`[[${pick([words(1), mark()])}]]`);
      else if (k < 0.96) parts.push(`<${tag()} title=${attrVal()} `); // a tag left open: runs into what follows
      else parts.push(`*${words(1)}*`);
    }
    return parts.join(pick([" ", " ", "", "\n"]));
  }
  const indent = () => pick(["    ", "\t", "  \t", "     "]);
  function htmlBlock(): string {
    switch (Math.floor(r() * 7)) {
      case 0: {
        const t = pick(["pre", "script", "style", "textarea"]);
        return `<${t}>\n${inline()}\n${chance(0.8) ? `</${t}>` : ""}`;
      }
      case 1:
        return `<!--\n${inline()}\n${chance(0.8) ? "-->" : ""}`;
      case 2:
        return `<?php\n${inline()}\n?>`;
      case 3:
        return `<!DOCTYPE ${words(1)}\n${inline()}>`;
      case 4:
        return `<![CDATA[\n${inline()}\n]]>`;
      case 5: {
        const t = pick(["div", "table", "p", "details", "section", "ul", "li", "blockquote", "h2"]);
        return `<${t}${chance(0.5) ? ` class=${attrVal()}` : ""}>\n${inline()}${chance(0.5) ? `\n</${t}>` : ""}`;
      }
      default:
        return `${chance(0.5) ? mark() : `<${tag()}${chance(0.5) ? ` title=${attrVal()}` : ""}>`}${chance(0.5) ? "\n" + inline() : ""}`;
    }
  }
  function block(d: number): string {
    const k = r();
    if (d < 4 && k < 0.14) {
      const ordered = chance(0.4);
      const marker = ordered ? pick(["1.", "1)", "2."]) : pick(["-", "*", "+"]);
      const items = 1 + Math.floor(r() * 3);
      const loose = chance(0.4);
      const out: string[] = [];
      for (let i = 0; i < items; i++) {
        const pad = pick([" ", "  ", "\t"]);
        const body = blocks(d + 1, 1 + Math.floor(r() * 2));
        const width = pad === "\t" ? null : marker.length + pad.length;
        const lines = body.split("\n");
        out.push(marker + pad + lines[0] + lines.slice(1).map((l) => "\n" + (l === "" ? "" : chance(0.1) ? l /* lazy */ : width === null ? "\t" + l : " ".repeat(width) + l)).join(""));
      }
      return out.join(loose ? "\n\n" : "\n");
    }
    if (d < 4 && k < 0.26) {
      const body = blocks(d + 1, 1 + Math.floor(r() * 2));
      const p = pick(["> ", ">", " > ", ">\t"]);
      return body.split("\n").map((l, i) => (i > 0 && chance(0.1) ? l : p + l)).join("\n");
    }
    if (k < 0.4) return inline();
    if (k < 0.45) return `${"#".repeat(1 + Math.floor(r() * 3))} ${inline().replace(/\n/g, " ")}`;
    if (k < 0.5) return `${inline()}\n${pick(["===", "---", "  ==="])}`;
    if (k < 0.54) {
      const f = pick(["```", "~~~", "````"]);
      return `${f}${pick(["", "js", "html"])}\n${inline()}\n${chance(0.85) ? f : ""}`;
    }
    if (k < 0.57) return indent() + inline().replace(/\n/g, "\n" + indent());
    if (k < 0.61) return `$$\n${pick([words(1), mark(), "a<b"])}\n${chance(0.85) ? "$$" : ""}`;
    if (k < 0.75) return htmlBlock();
    if (k < 0.78) return `[${words(1)}]: /u${pick(["", ` "${words(1)} ${mark()}"`, `\n  '${mark()}\n${words(1)}'`, ` (${mark()})`])}`;
    if (k < 0.83) return !FOOT ? inline() : `[^${1 + Math.floor(r() * 3)}]: ${inline()}${chance(0.6) ? "\n\n" + indent() + inline() : ""}`;
    if (d < 4 && k < 0.88) {
      const f = pick([":::", "::::"]);
      return `${f}${pick(["note", "columns", "x"])}${chance(0.3) ? `{title="${mark()}"}` : ""}\n${blocks(d + 1, 1 + Math.floor(r() * 2))}\n${chance(0.85) ? f : ""}`;
    }
    if (k < 0.9) return `::${pick(["x", "video"])}[${pick([words(1), mark()])}]`;
    if (k < 0.94) return `| ${words(1)} | ${pick([words(1), mark()])} |\n| --- | --- |\n| ${pick([words(1), mark(), "<b>"])} | ${inline().replace(/\n/g, " ").replace(/\|/g, "")} |`;
    if (k < 0.96) return pick(["***", "---", "___"]);
    return mark();
  }
  function blocks(d: number, n: number): string {
    return Array.from({ length: n }, () => block(d)).join(pick(["\n\n", "\n\n", "\n", "\n\n\n"]));
  }
  let md = blocks(0, 2 + Math.floor(r() * 5));
  if (chance(0.15)) md = `---\ntitle: ${words(1)}\n---\n` + md;
  if (chance(0.25)) md = md.replace(/\n/g, "\r\n");
  else if (chance(0.1)) md = md.replace(/\n/g, () => (chance(0.5) ? "\r\n" : "\n"));
  return md + (chance(0.5) ? "\n" : "");
}

// ------------------------------------------------------------ the registry

export interface Generator {
  id: "tags" | "blocks" | "footnotes" | "containers";
  /** Where it came from. */
  origin: string;
  /** A stream of notes for one seed: the same seed gives the same notes. */
  stream(seed: number): () => string;
}

export const GENERATORS: readonly Generator[] = [
  { id: "tags", origin: "review F-8 (#473 redactionPreviewFuzz)", stream: (seed) => { const r = rng(seed); return () => tagCase(r); } },
  {
    id: "blocks",
    origin: "review 6 (rr6/r473-md-fuzz.mjs)",
    stream: (seed) => {
      const r = rng6(seed);
      let tok = 0;
      const T = () => `Q${(tok++).toString(36).padStart(4, "0")}Z`;
      return () => markdownNote(r, T);
    },
  },
  {
    id: "footnotes",
    origin: "review 8 (RR8-473-2)",
    stream: (seed) => {
      const r = rng6(seed);
      let tok = 0;
      const T = () => `Z${++tok}Z`;
      return () => footnoteNote(r, T);
    },
  },
  {
    id: "containers",
    origin: "review 8 (rr8 and R6 r473-fuzz3)",
    // Each note picks its own options, as fuzz3.sh ran three configurations: all, no footnotes, neither.
    stream: (seed) => {
      const r = rng(seed);
      return () => {
        const k = r();
        return containerNote(r, k < 0.5 ? {} : k < 0.75 ? { noFoot: true } : { noCritic: true, noFoot: true });
      };
    },
  },
];

/** The night's seed: the UTC date as a number (20261114), so a night names its notes. */
export function seedForDate(d: Date): number {
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** A generator's own seed for a night: different streams, still named by the night. */
export function generatorSeed(night: number, index: number): number {
  return (Math.imul(night, 0x9e3779b1) + index * 0x85ebca6b) >>> 0;
}
