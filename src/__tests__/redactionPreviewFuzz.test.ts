/**
 * Review F-8 (coordinator's decision, 12.11): the export's mark parser
 * (`redactMarks`) and the preview's HTML parser (parse5 through rehype-raw)
 * are different code. The property that matters: every passage the preview
 * shades as redacted is gone from the export (preview ⊆ export). The export
 * may remove more (it fails closed); it must never keep a shaded passage.
 *
 * The preview's side is the browser's own HTML parser (`DOMParser`), which
 * implements the same WHATWG tokenizer and tree builder as parse5. Over a
 * seeded fuzz set of `<redact>` tag variants and the HTML constructs that
 * change how a tag is read (comments, other tags' attributes, raw-text
 * elements, CDATA, end of input), each text run carries a unique token; a
 * token inside a `redact` element must not survive `exportReadyText`.
 * Under vitest's jsdom, DOMParser is parse5 itself, the preview's parser; in
 * the offline Chromium harness it is Blink's. Skipped where there is none.
 *
 * Review 6 (RR6-473-1) added a second generator: notes built from Markdown
 * blocks (paragraphs, headings, block quotes and lists two deep, fences,
 * indented code and math inside them, tables, HTML blocks), rendered the way
 * the preview renders them, Markdown first (micromark, CommonMark + GFM
 * tables + math, raw HTML kept) and that HTML through DOMParser.
 *
 * Review 8 (RR8-473-1, RR8-473-2) added what the preview does before and
 * after that: it parses `prepareCriticMarkup(note)`, whose delimiters are one
 * character each, and it appends the footnotes after the last block.
 */
import { micromark } from "micromark";
import { directive, directiveHtml, type Handle } from "micromark-extension-directive";
import { gfmFootnote, gfmFootnoteHtml } from "micromark-extension-gfm-footnote";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";
import { math, mathHtml } from "micromark-extension-math";
import { describe, expect, it } from "vitest";
import { removeRedacted } from "../lib/redaction";
import { prepareCriticMarkup, prepareCriticMarkupMapped } from "../renderer/criticMarkup";
import { exportReadyText } from "../storage/exportReady";

/** A small seeded PRNG (mulberry32), so a failure names a case that comes back. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["redact", "REDACT", "Redact", "rEdAcT"];
const AFTER = ["", " ", "\t", "\n", "\f", "\r", "/", " /", "  "];
const ATTRS = ["", ' class="x"', " id=1", " title='a>b'", ' title="a>b"', " a=b>c", " x=`y`", ' data-x="</redact>"', " a", ' a="', " a='", " /x", " =x"];
const CLOSERS = ["</redact>", "</REDACT>", "</redact >", "</redact\t>", "</redact foo>", "</redact/>", "</redact x='>'>", "</ redact>", "</redact", "</redactx>", "</redac>"];
/** Constructs that change how what follows them is read. `@` is where a closing tag variant goes. */
const WRAPS = [
  "<!-- @ -->",
  "<!--@-->",
  "<!-->@",
  "<!--->@",
  "<!-- @",
  "<!--- @ --->",
  "<!@>",
  "<?@?>",
  '<a title="@">',
  "<a title='@'>",
  "<a title=@>",
  '<img alt="@">',
  "<script>@</script>",
  "<style>@</style>",
  "<textarea>@</textarea>",
  "<title>@</title>",
  "<xmp>@</xmp>",
  "<noembed>@</noembed>",
  "<noframes>@</noframes>",
  "<iframe>@</iframe>",
  "<svg><![CDATA[@]]></svg>",
  "<math><![CDATA[@]]></math>",
  "<svg><title>@</title></svg>",
  "`@`",
  "\\@",
  "&lt;@",
  "<p>@</p>",
  "<table><tr><td>@</td></tr></table>",
  "<b>@</b>",
  "@",
];

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

function openTag(r: () => number): string {
  const after = pick(r, AFTER);
  const attrs = after === "" || after.endsWith("/") ? "" : pick(r, ATTRS);
  return `<${pick(r, NAMES)}${after}${attrs}${r() < 0.85 ? ">" : ""}`;
}

/** One case: text runs, each with its own token, around marks and wrapped closing variants. */
function makeCase(r: () => number): { md: string; tokens: string[] } {
  const tokens: string[] = [];
  const tok = () => {
    const t = `TK${tokens.length}Q`;
    tokens.push(t);
    return t;
  };
  let md = tok();
  const parts = 1 + Math.floor(r() * 4);
  for (let p = 0; p < parts; p++) {
    md += ` ${openTag(r)}${tok()}`;
    const inner = Math.floor(r() * 3);
    for (let k = 0; k < inner; k++) {
      const what = r();
      if (what < 0.5) md += pick(r, WRAPS).replace("@", pick(r, CLOSERS)) + tok();
      else if (what < 0.7) md += `${openTag(r)}${tok()}`;
      else md += (r() < 0.5 ? "\n\n" : " ") + tok();
    }
    if (r() < 0.8) md += pick(r, CLOSERS);
    md += ` ${tok()}`;
  }
  return { md, tokens };
}

/** The tokens the preview shades: inside a `redact` element of the parsed document. */
function shadedTokens(md: string, tokens: string[]): string[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${md}</body>`, "text/html");
  const shaded = [...doc.querySelectorAll("redact")].map((e) => e.textContent ?? "").join("\u0000");
  return tokens.filter((t) => shaded.includes(t));
}


/** Review 6's PRNG and generator (`rr6/r473-md-fuzz.mjs`), kept as written so its seeds name the same notes. */
function rng6(seed: number) {
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

function markdownNote(r: () => number, T: () => string): string {
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

/** The preview's HTML for a note: Markdown first, raw HTML kept, as remark-rehype + rehype-raw hand it to parse5. */
const previewHtml = (md: string) =>
  micromark(md, { allowDangerousHtml: true, extensions: [gfmTable(), math()], htmlExtensions: [gfmTableHtml(), mathHtml()] });

const haveDom = typeof DOMParser !== "undefined" && typeof document !== "undefined";

describe("what the preview shades, the export removes (F-8, preview ⊆ export)", () => {
  (haveDom ? it : it.skip)("the fixed corpus and 3,000 seeded variants: no shaded token survives the export", async () => {
    const S = "סוד-מקור";
    const corpus = [
      `<redact class="x">${S}</redact>`,
      `<redact\tid=1>${S}</redact>`,
      `<redact/>${S}`,
      `<redact title='a>b'>${S}</redact>`,
      `<redact><!-- </redact> -->${S}</redact>`,
      `<redact><a title="</redact>">${S}</a></redact>`,
      `<redact><script></redact></script>${S}</redact>`,
      `<redact><textarea></redact></textarea>${S}</redact>`,
      `<redact><svg><![CDATA[</redact>]]></svg>${S}</redact>`,
    ];
    const cases = corpus.map((md) => ({ md, tokens: [S] }));
    const r = rng(0x4c554d45);
    for (let i = 0; i < 3000; i++) cases.push(makeCase(r));
    const kept: string[] = [];
    let shadedTotal = 0;
    for (const { md, tokens } of cases) {
      const shaded = shadedTokens(md, tokens);
      if (!shaded.length) continue;
      shadedTotal += shaded.length;
      const out = await exportReadyText(md);
      const leak = shaded.filter((t) => out.includes(t));
      if (leak.length) kept.push(`${JSON.stringify(md)} kept ${leak.join(",")} → ${JSON.stringify(out)}`);
    }
    // The fuzz set does reach the preview's shading: a corpus that shaded nothing would prove nothing.
    expect(shadedTotal).toBeGreaterThan(2000);
    expect(kept.slice(0, 10)).toEqual([]);
  }, 60_000);

  it("a closing mark the Markdown layer shows as text ends nothing: code, math, link targets, escapes", async () => {
    const S = "Dana Levi";
    for (const md of [
      `<redact>a \`</redact>\` ${S}</redact> b`,
      `<redact>a \`x\n</redact>\` ${S}</redact> b`,
      `<redact>a \\</redact> ${S}</redact> b`,
      `<redact>a $x</redact>$ ${S}</redact> b`,
      `<redact>a [l](</redact>) ${S}</redact> b`,
      `<redact>a [l](x "</redact>") ${S}</redact> b`,
      `<redact>a [[</redact>]] ${S}</redact> b`,
    ]) {
      const out = await exportReadyText(md);
      expect(out, JSON.stringify(md)).not.toContain(S);
      expect(out.endsWith(" b"), JSON.stringify(md)).toBe(true);
    }
    // A `<redact>` on its own line opens an HTML block: the paragraph after the code is a `p` inside the
    // passage, and the `</redact>` typed in it closes nothing in the preview (review 6), so " b" is shaded too.
    for (const md of [`<redact>\n\n\`\`\`\n</redact>\n\`\`\`\n\n${S}</redact> b`, `<redact>\n\n    </redact>\n\n${S}</redact> b`]) {
      expect(await exportReadyText(md), JSON.stringify(md)).toBe("█████");
    }
    // A closing mark the preview does read still closes: the text after it stays.
    expect(await exportReadyText(`<redact>${S}</redact> <p>kept</p> \`code\` after`)).toBe(`█████ <p>kept</p> \`code\` after`);
    expect(await exportReadyText(`<redact><b>${S}</b><span>x</span></redact> kept`)).toBe("█████ kept");
  });
  (haveDom ? it : it.skip)("notes built from Markdown blocks, 3 seeds × 4,000: no shaded token survives the export (review 6)", async () => {
    const kept: string[] = [];
    let shadedTotal = 0;
    for (const seed of [6, 11, 12]) {
      const r = rng6(seed);
      let tok = 0;
      const T = () => `Q${(tok++).toString(36).padStart(4, "0")}Z`;
      for (let i = 0; i < 4000; i++) {
        const md = markdownNote(r, T);
        const doc = new DOMParser().parseFromString(`<!doctype html><body>${previewHtml(md)}`, "text/html");
        const shaded = new Set<string>();
        for (const el of doc.querySelectorAll("redact")) for (const m of (el.textContent ?? "").matchAll(/Q[0-9a-z]{4}Z/g)) shaded.add(m[0]);
        if (!shaded.size) continue;
        shadedTotal += shaded.size;
        const out = await exportReadyText(md);
        const leak = [...shaded].filter((t) => out.includes(t));
        if (leak.length) kept.push(`seed ${seed} #${i}: ${JSON.stringify(md)} kept ${leak.join(",")}`);
      }
    }
    expect(shadedTotal).toBeGreaterThan(3000);
    expect(kept.slice(0, 10)).toEqual([]);
  }, 120_000);

  it("a close inside a list item, a block quote or a table cell ends nothing the preview shades (review 6, RR6-473-1)", async () => {
    const secret = "Yossi Cohen";
    for (const md of [
      "Interview notes.\n\n<redact>\n\n- Source A: Dana Levi</redact>\n- Source B: Yossi Cohen, 054-0000000\n\nPublished text.",
      "<redact>\n\n> Source: Dana Levi</redact>\n> Source: Yossi Cohen\n\nPublished text.",
      "<redact>\n\n| name | phone |\n| --- | --- |\n| Dana Levi</redact> | 1 |\n| Yossi Cohen | 2 |\n\nPublished text.",
      "<redact>\n\n- raw notes:\n  ```\n  </redact>\n  ```\n- Source: Yossi Cohen\n",
      "<redact>\n\n- 1. raw:\n     ```\n     </redact>\n     ```\n- Source: Yossi Cohen\n",
    ]) {
      const out = await exportReadyText(md);
      expect(out, JSON.stringify(md)).not.toContain(secret);
      expect(out, JSON.stringify(md)).not.toContain("Dana Levi");
    }
    // The close on its own line after the list does close: the text after it stays.
    expect(await exportReadyText("<redact>\n\n- Source A: Dana Levi\n- Source B: Yossi Cohen\n\n</redact>\n\nPublished text.")).toBe("█████\n\nPublished text.");
    expect(await exportReadyText("> <redact>Dana Levi</redact> said\n\nPublished text.")).toBe("> █████ said\n\nPublished text.");
  });
});

/** The preview as pipeline.ts builds it: CriticMarkup swapped first, then GFM tables and footnotes, math and directives (an unknown one is a div). */
function previewHtml8(md: string): string {
  const asDiv: Handle = function (d) {
    this.tag("<div>");
    if (d.label) this.raw(d.label);
    if (d.content) this.raw(d.content);
    this.tag("</div>");
    return undefined;
  };
  return micromark(prepareCriticMarkup(md), {
    allowDangerousHtml: true,
    extensions: [gfmTable(), gfmFootnote(), math(), directive()],
    htmlExtensions: [gfmTableHtml(), gfmFootnoteHtml(), mathHtml(), directiveHtml({ "*": asDiv })],
  });
}

function shaded8(md: string): string[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${previewHtml8(md)}`, "text/html");
  const out = new Set<string>();
  for (const el of doc.querySelectorAll("redact")) for (const m of (el.textContent ?? "").matchAll(/Z\d+Z/g)) out.add(m[0]);
  return [...out];
}

describe("review 8: the text the preview parses, and where it puts footnotes", () => {
  it("prepareCriticMarkupMapped gives the preview's text and each character's place in the note", () => {
    for (const md of ["plain", "a {>>c<<} b {~~x~>y~~} {++i++}{--d--} {==h==}", "{++x++}{>>@dana<<} z", "user \uE003 glyph {>>c<<}", "`{>>code<<}` {>>c<<}"]) {
      const { text, at } = prepareCriticMarkupMapped(md);
      expect(text).toBe(prepareCriticMarkup(md));
      expect(at.length).toBe(text.length + 1);
      expect(at[text.length]).toBe(md.length);
      // Generated: the sentinels, the escape and the author tag's own characters (`@dana` is rebuilt).
      const made = new Set<number>();
      for (const m of text.matchAll(/\uE007@[^\uE008]*\uE008/g)) for (let i = 0; i < m[0].length; i++) made.add((m.index ?? 0) + i);
      for (let i = 0; i < text.length; i++) {
        expect(at[i + 1] >= at[i]).toBe(true);
        const c = text.charCodeAt(i);
        if ((c < 0xe000 || c > 0xe00b) && !made.has(i) && !(i > 0 && text.charCodeAt(i - 1) === 0xe00b)) expect(md[at[i]]).toBe(text[i]);
      }
    }
  });
  (haveDom ? it : it.skip)("a suggestion's `>` inside a tag ends nothing the preview keeps open (RR8-473-1)", async () => {
    for (const md of [
      "Interview notes.\n\n<redact>\nZ1Z Source: Dana Levi <span title={>>check<<} </redact> Z2Z Yossi Cohen, 054-0000000\n\nZ3Z Met at the cafe on Herzl street.\n",
      "<redact>\nZ1Z Dana Levi <b data-x={~~a~>b~~} </redact> Z2Z Yossi Cohen\n\nZ3Z next paragraph\n",
      "Z0Z public <redact>Z1Z secret</redact> public again.\n\n<div>\n<redact>Z4Z <i title={>>x<<} </redact> Z5Z still secret?\n</div>\n\nZ6Z after\n",
    ]) {
      const shaded = shaded8(md);
      expect(shaded.length, JSON.stringify(md)).toBeGreaterThan(1);
      const out = await exportReadyText(md);
      expect(shaded.filter((t) => out.includes(t)), JSON.stringify(md)).toEqual([]);
    }
    // Without the suggestion the close closes, and the text after it stays.
    expect(await exportReadyText("<redact>\nDana Levi <span title=check> </redact> kept\n\nkept too\n")).toContain("kept too");
  });
  (haveDom ? it : it.skip)("a passage still open at the end takes every footnote with it, as the preview shades them (RR8-473-2)", async () => {
    const f1 = "Dana told me[^1] that the deal closed on Sunday.\n\n[^1]: Z1Z Dana Levi, deputy CFO, 054-0000000\n\n## Private notes\n<redact>\nZ2Z Everything below stays private.\n";
    const f2 = "Text[^1].\n\n[^1]: Z1Z source name </redact> Z2Z more\n\n<redact>\n\nZ3Z private\n";
    for (const md of [f1, f2]) {
      const shaded = shaded8(md);
      expect(shaded, JSON.stringify(md)).toContain("Z1Z");
      const out = await exportReadyText(md);
      expect(shaded.filter((t) => out.includes(t)), JSON.stringify(md)).toEqual([]);
    }
    expect(removeRedacted(f1).text).toBe("Dana told me[^1] that the deal closed on Sunday.\n\n\n\n## Private notes\n█████");
    // Closed: the footnote stays (the preview shows it outside the passage).
    expect(await exportReadyText("Dana told me[^1] that.\n\n[^1]: Z1Z Dana Levi\n\n<redact>\nZ2Z private\n</redact>\n")).toContain("Z1Z Dana Levi");
  });
  (haveDom ? it : it.skip)("notes with footnotes and suggestions, 2 seeds × 1,500: no shaded token survives the export", async () => {
    const kept: string[] = [];
    let shadedTotal = 0;
    for (const seed of [21, 22]) {
      const r = rng6(seed);
      let tok = 0;
      const T = () => `Z${++tok}Z`;
      const one = <X,>(a: readonly X[]): X => a[Math.floor(r() * a.length)];
      const MARK = () => one(["<redact>", "</redact>", "<redact class=x>", "</REDACT>"]);
      for (let i = 0; i < 1500; i++) {
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
        const md = blocks.join("\n\n");
        const shaded = shaded8(md);
        if (!shaded.length) continue;
        shadedTotal += shaded.length;
        const out = await exportReadyText(md);
        const leak = shaded.filter((t) => new RegExp(`${t}(?!\\d)`).test(out));
        if (leak.length) kept.push(`seed ${seed} #${i}: ${JSON.stringify(md)} kept ${leak.join(",")}`);
      }
    }
    expect(shadedTotal).toBeGreaterThan(1500);
    expect(kept.slice(0, 10)).toEqual([]);
  }, 120_000);
});
