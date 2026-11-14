/**
 * Input generators for the decoder fuzzer (plan W1.27). No dependencies:
 * the runner (scripts/fuzz/run.mjs) loads this file with Node's type
 * stripping, and the vitest smoke test imports it.
 *
 * Every input is a pure function of (seed, index), so a failure found at
 * index i of a million is reproduced with `--seed S --from i --runs 1`.
 *
 * Inputs are built from the formats' own pieces (Markdown blocks and
 * inlines, YAML, JSON, BibTeX, URLs) with Hebrew, Arabic, bidi controls,
 * combining marks and emoji mixed in, then mutated (bytes flipped, slices
 * cut, duplicated or nested thousands deep) — the inputs that make parsers
 * recurse without end or go quadratic.
 */

export type GenKind = "markdown" | "yaml" | "json" | "bibtex" | "url" | "text" | "csv" | "manifest";

export type Rng = () => number;

/** mulberry32: small, fast, good enough to spread inputs. */
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

/** The rng for input `index` of a run with `seed`. */
export function rngFor(seed: number, index: number): Rng {
  return rng((Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index, 0xc2b2ae35)) >>> 0);
}

const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: Rng, n: number) => Math.floor(r() * n);

const ALPHABET = [
  "a", "Z", "0", " ", " ", "\n", "\t", "\r\n", "שלום", "עולם", "ש", "ֳ", "مرحبا", "é", "é", "😀", "👩‍👩‍👧",
  "‏", "‎", "‮", "⁦", "⁩", " ", "\u0000", "﻿", "\ud800", "\udc00", "\\", "\"", "'", "`",
  "<", ">", "&", "#", "*", "_", "~", "|", "[", "]", "(", ")", "{", "}", ":", ";", ",", ".", "!", "?", "=", "-", "+", "/", "%", "$", "@", "^",
];

function text(r: Rng, max = 40): string {
  let s = "";
  const n = int(r, max);
  for (let i = 0; i < n; i++) s += pick(r, ALPHABET);
  return s;
}

const word = (r: Rng) => pick(r, ["note", "שלום", "عربي", "Plan", "x", "a b", "", "😀", "[[x]]", "**", "a|b", "#h", "日本"]);

function inline(r: Rng, depth: number): string {
  if (depth > 3) return word(r);
  const inner = () => inline(r, depth + 1);
  switch (int(r, 18)) {
    case 0: return `**${inner()}**`;
    case 1: return `_${inner()}_`;
    case 2: return `\`${text(r, 10)}\``;
    case 3: return `[${inner()}](${pick(r, ["https://example.com/a", "./n.md", "javascript:alert(1)", "<a b.md>", "#h", "x(y).md", ""])})`;
    case 4: return `[[${word(r)}${pick(r, ["", "|" + word(r), "#" + word(r), "#^b"])}]]`;
    case 5: return `![${word(r)}](${pick(r, ["a.png", "data:image/svg+xml,<svg onload=alert(1)>", "https://example.com/i.png"])})`;
    case 6: return `<${pick(r, ["span", "img", "script", "iframe", "a", "div", "svg"])} ${pick(r, ["onerror=x", "src=x", "href=javascript:x", "style=x", ""])}>${inner()}`;
    case 7: return `$${text(r, 8)}$`;
    case 8: return `==${inner()}==`;
    case 9: return `{++${inner()}++}{--${word(r)}--}{~~a~>b~~}`;
    case 10: return `~~${inner()}~~`;
    case 11: return `#${word(r)}`;
    case 12: return `:${word(r)}:`;
    case 13: return `&${pick(r, ["amp", "lt", "#x2028", "#0", "nbsp", "unknown"])};`;
    case 14: return `^[${inner()}]`;
    case 15: return "\\" + pick(r, ALPHABET);
    default: return text(r, 12);
  }
}

function block(r: Rng, depth: number): string {
  const line = () => Array.from({ length: 1 + int(r, 4) }, () => inline(r, 0)).join(" ");
  if (depth > 4) return line();
  switch (int(r, 16)) {
    case 0: return `${"#".repeat(1 + int(r, 7))} ${line()}`;
    case 1: return Array.from({ length: 1 + int(r, 4) }, () => `${" ".repeat(int(r, 6))}${pick(r, ["-", "*", "1.", "2)", "- [ ]", "- [x]"])} ${block(r, depth + 1)}`).join("\n");
    case 2: return block(r, depth + 1).split("\n").map((l) => "> " + l).join("\n");
    case 3: {
      const f = pick(r, ["```", "~~~", "````"]);
      return `${f}${pick(r, ["", "js", "mermaid", "math", "live-js", "csv", "dataview", "chart"])}\n${text(r, 60)}\n${pick(r, [f, "", "```"])}`;
    }
    case 4: return `| ${line()} | ${word(r)} |\n|${pick(r, ["---", ":-:", "-"])}|---|\n| ${line()} | ${line()} |`;
    case 5: return `---\n${yaml(r, 0)}\n${pick(r, ["---", "", "..."])}`;
    case 6: return `$$\n${text(r, 30)}\n$$`;
    case 7: return `:::${pick(r, ["note", "warning", "details", ""])}\n${block(r, depth + 1)}\n:::`;
    case 8: return `[^${word(r)}]: ${line()}`;
    case 9: return `[${word(r)}]: ${pick(r, ["./a.md", "<b c.md>", "https://example.com"])} "${word(r)}"`;
    case 10: return pick(r, ["***", "---", "___", "* * *"]);
    case 11: return `<div>\n${block(r, depth + 1)}\n</div>`;
    case 12: return `    ${text(r, 30)}`;
    case 13: return `${line()}\n${pick(r, ["===", "---"])}`;
    case 14: return `<!-- ${text(r, 20)}${pick(r, ["-->", ""])}`;
    default: return line();
  }
}

function yamlScalar(r: Rng): string {
  return pick(r, ["a", "שלום", "'quoted'", '"dq \\u00e9"', "123", "1e999", "-0", "true", "null", "~", "2026-11-10", "[a, b]", "{a: 1}", "&a x", "*a", "!!str x", "|\n  block", ">-\n  folded", ": x", "'unclosed", "[", "{", "@x", "%TAG"]);
}

function yaml(r: Rng, depth: number): string {
  const n = 1 + int(r, 5);
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = pick(r, ["title", "tags", "aliases", "date", "שם", "a b", "? complex", "<<", "- item", "x"]);
    if (depth < 4 && r() < 0.25) lines.push(`${pad}${key}:\n${yaml(r, depth + 1)}`);
    else if (r() < 0.2) lines.push(`${pad}${key}:\n${pad}  - ${yamlScalar(r)}\n${pad}  - ${yamlScalar(r)}`);
    else lines.push(`${pad}${key}: ${yamlScalar(r)}`);
  }
  return lines.join("\n");
}

function json(r: Rng, depth: number): string {
  if (depth > 5) return pick(r, ["1", '"s"', "null", "true", "-1.5e3", '"\\ud800"', '"שלום"']);
  switch (int(r, 7)) {
    case 0: return `[${Array.from({ length: int(r, 4) }, () => json(r, depth + 1)).join(",")}]`;
    case 1:
    case 2: return `{${Array.from({ length: int(r, 4) }, () => `${JSON.stringify(word(r))}:${json(r, depth + 1)}`).join(",")}}`;
    case 3: return JSON.stringify(text(r, 20));
    case 4: return String((r() - 0.5) * 10 ** int(r, 30));
    default: return pick(r, ["null", "true", "false", "0", "{}", "[]", '""']);
  }
}

function bibtex(r: Rng): string {
  const n = 1 + int(r, 3);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const fields = Array.from({ length: int(r, 5) }, () => `  ${pick(r, ["author", "title", "year", "journal", "doi", "url", "x"])} = ${pick(r, [`{${inline(r, 2)}}`, `"${word(r)}"`, "2026", `{{${word(r)}}}`, "{unclosed", "#", `{${"{".repeat(int(r, 50))}`])},`);
    out.push(`@${pick(r, ["article", "book", "misc", "comment", "string", "preamble", "", "@"])}{${pick(r, ["key", "", "a b", "שלום"])},\n${fields.join("\n")}\n${pick(r, ["}", "", "}}", ")"])}`);
  }
  return out.join("\n");
}

function url(r: Rng): string {
  return (
    pick(r, ["https://", "http://", "javascript:", "JaVaScRiPt:", "data:", "vbscript:", "file://", "//", "", "blob:", "mailto:", "ws://", " java\tscript:", "\u0000javascript:"]) +
    pick(r, ["example.com", "www.youtube.com/watch?v=abc", "youtu.be/x", "vimeo.com/1", "twitter.com/a/status/1", "localhost:1234", "[::1]", "xn--", "שלום.example", "a@b", "%00", "%E2%80%AE"]) +
    pick(r, ["", "/", "/a?b=c#d", "/../..", "?" + text(r, 10), "#" + text(r, 5)])
  );
}

function csv(r: Rng): string {
  const rows = 1 + int(r, 6);
  const sep = pick(r, [",", ";", "\t", "|"]);
  return Array.from({ length: rows }, () => Array.from({ length: 1 + int(r, 5) }, () => pick(r, [word(r), `"${text(r, 8)}"`, '"a""b"', '"unclosed', "1,5", "", "=cmd()"])).join(sep)).join(pick(r, ["\n", "\r\n", "\r"]));
}

function manifest(r: Rng): string {
  const obj: Record<string, unknown> = {};
  for (const k of ["id", "name", "version", "main", "permissions", "capabilities", "minAppVersion", "author"]) {
    if (r() < 0.7) obj[k] = JSON.parse(json(r, 3));
  }
  if (r() < 0.5) obj.permissions = [pick(r, ["network", "files", "clipboard", "editor", "*", ""])];
  return JSON.stringify(obj);
}

/** Cut, flip, repeat and nest: what grammar-built inputs alone do not reach. */
function mutate(r: Rng, s: string): string {
  const rounds = int(r, 4);
  for (let i = 0; i < rounds; i++) {
    const at = int(r, s.length + 1);
    switch (int(r, 7)) {
      case 0: s = s.slice(0, at) + s.slice(at + 1 + int(r, 20)); break;
      case 1: s = s.slice(0, at) + pick(r, ALPHABET) + s.slice(at); break;
      case 2: s = s.slice(0, at) + s.slice(at, at + 1 + int(r, 30)).repeat(2 + int(r, 30)) + s.slice(at); break;
      case 3: {
        // Deep nesting: the input that ends a recursive parser.
        const [o, c] = pick(r, [["[", "]"], ["{", "}"], ["(", ")"], ["> ", ""], ["- ", ""], ["**", "**"], ["<div>", "</div>"], ["[[", "]]"], ["`", "`"]]);
        const n = 100 + int(r, 3000);
        s = s.slice(0, at) + o.repeat(n) + (r() < 0.5 ? c.repeat(n) : "") + s.slice(at);
        break;
      }
      case 4: s = s.slice(0, at); break;
      case 5: s = s.slice(0, at) + String.fromCharCode(int(r, 0x10000)) + s.slice(at); break;
      default: s = s + s.slice(0, int(r, s.length)); break;
    }
  }
  return s.length > 20_000 ? s.slice(0, 20_000) : s;
}

/** Input `index` of kind `kind` for run `seed`. */
export function generate(kind: GenKind, seed: number, index: number): string {
  const r = rngFor(seed, index);
  let s: string;
  switch (kind) {
    case "markdown": s = Array.from({ length: 1 + int(r, 6) }, () => block(r, 0)).join(pick(r, ["\n\n", "\n", "\r\n\r\n"])); break;
    case "yaml": s = yaml(r, 0); break;
    case "json": s = json(r, 0); break;
    case "bibtex": s = bibtex(r); break;
    case "url": s = url(r); break;
    case "csv": s = csv(r); break;
    case "manifest": s = manifest(r); break;
    default: s = text(r, 200); break;
  }
  return r() < 0.6 ? mutate(r, s) : s;
}
