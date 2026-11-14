/**
 * The CSS sanitizer for vault snippets (plan W1.21): a snippet may restyle
 * the app, never reach the network.
 *
 * The page's CSP alone does not stop a stylesheet: it allows `img-src https:`
 * (pasted images) and Google Fonts in `style-src` / `font-src`. So a snippet
 * is tokenized (CSS Syntax Level 3: comments, strings, escapes, url()
 * tokens) and rebuilt without:
 *
 *   - any `@import` (local or remote) — dropped up to its `;`;
 *   - any declaration that loads something: `url(…)` / `src(…)` /
 *     `image-set(…)` / `image(…)` / `cross-fade(…)` / `element(…)` whose
 *     target is not a `data:` image or font or a `#fragment`, however it is
 *     spelled (`u\72l(`, `URL(`, quoted or not, inside `var()` fallbacks);
 *   - `attr(… url)`, which turns an attribute into a URL;
 *   - legacy script hooks: `expression(…)`, `behavior`, `-moz-binding`;
 *   - `@namespace` with a URL and `@document` / `@-moz-document`.
 *
 * Function names are compared after decoding escapes and folding case, the
 * way the browser reads them. Anything removed is reported (line and
 * reason) so the settings can show it. Output keeps the rest of the text.
 */

export type RemovedReason = "import" | "remote-url" | "script" | "at-rule";

export interface SanitizeResult {
  css: string;
  removed: Array<{ line: number; reason: RemovedReason; text: string }>;
}

export const MAX_SNIPPET_BYTES = 256 * 1024;

const LOADING_FUNCTIONS = new Set(["url", "src", "image-set", "-webkit-image-set", "image", "cross-fade", "-webkit-cross-fade", "element", "-moz-element"]);
const SCRIPT_FUNCTIONS = new Set(["expression"]);
const SCRIPT_PROPERTIES = new Set(["behavior", "-moz-binding", "-ms-behavior"]);
const DROP_AT_RULES = new Set(["import", "document", "-moz-document"]);

/** A `data:` URL that cannot fetch anything: images and fonts. */
const SAFE_DATA = /^data:(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)|font\/[\w.+-]+|application\/(font-woff2?|x-font-[\w-]+|vnd\.ms-fontobject))[;,]/i;

/** Decode CSS escapes (`\72` → `r`, `\(` → `(`) in an identifier. */
export function decodeEscapes(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([^\r\n\f0-9a-fA-F])/g, (_, hex: string | undefined, ch: string | undefined) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp);
    }
    return ch ?? "";
  });
}

/** Whether a url()'s target is harmless (a data: image or font, or a fragment). */
export function safeUrlTarget(raw: string): boolean {
  const target = decodeEscapes(raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2")).trim();
  if (target.startsWith("#")) return true;
  return SAFE_DATA.test(target.replace(/\s+/g, ""));
}

type Tok =
  | { t: "ws" | "comment" | "other"; v: string }
  | { t: "string"; v: string; value: string }
  | { t: "ident"; v: string; name: string }
  | { t: "function"; v: string; name: string }
  | { t: "url"; v: string; target: string }
  | { t: "at"; v: string; name: string }
  | { t: "{" | "}" | ";" | ":" | "(" | ")"; v: string };

const isIdentStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isIdentChar = (c: string) => /[A-Za-z0-9_\-\u0080-￿]/.test(c);

/** Tokenize CSS (enough of CSS Syntax 3 for the checks above). */
export function tokenize(css: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = css.length;
  const startsEscape = (j: number) => css[j] === "\\" && j + 1 < n && css[j + 1] !== "\n";
  const readName = () => {
    let s = "";
    while (i < n) {
      if (isIdentChar(css[i])) s += css[i++];
      else if (startsEscape(i)) {
        const m = /^\\([0-9a-fA-F]{1,6}[ \t\r\n\f]?|[\s\S])/.exec(css.slice(i, i + 8))!;
        s += m[0];
        i += m[0].length;
      } else break;
    }
    return s;
  };
  while (i < n) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out.push({ t: "comment", v: css.slice(i, stop) });
      i = stop;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(css[j])) j++;
      out.push({ t: "ws", v: css.slice(i, j) });
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < n && css[j] !== c && css[j] !== "\n") {
        if (css[j] === "\\" && j + 1 < n) {
          value += css.slice(j, j + 2);
          j += 2;
        } else value += css[j++];
      }
      if (css[j] === c) j++;
      out.push({ t: "string", v: css.slice(i, j), value: decodeEscapes(value) });
      i = j;
    } else if (c === "@") {
      i++;
      const raw = readName();
      out.push({ t: "at", v: `@${raw}`, name: decodeEscapes(raw).toLowerCase() });
    } else if (isIdentStart(c) || startsEscape(i) || (c === "-" && (isIdentStart(css[i + 1] ?? "") || css[i + 1] === "-" || startsEscape(i + 1)))) {
      const start = i;
      const raw = readName();
      const name = decodeEscapes(raw).toLowerCase();
      if (css[i] === "(") {
        i++;
        if (name === "url") {
          // A url token: unquoted contents up to ")"; a quoted one is a function with a string.
          let j = i;
          while (j < n && /\s/.test(css[j])) j++;
          if (css[j] !== '"' && css[j] !== "'") {
            let k = j;
            while (k < n && css[k] !== ")") k += css[k] === "\\" ? 2 : 1;
            out.push({ t: "url", v: css.slice(start, Math.min(n, k + 1)), target: css.slice(j, k) });
            i = Math.min(n, k + 1);
            continue;
          }
        }
        out.push({ t: "function", v: css.slice(start, i), name });
      } else out.push({ t: "ident", v: css.slice(start, i), name });
    } else if ("{};:()".includes(c)) {
      out.push({ t: c as "{", v: c });
      i++;
    } else {
      out.push({ t: "other", v: c });
      i++;
    }
  }
  return out;
}

/** Why a run of tokens (one declaration or prelude) must go, or null. */
function verdict(toks: Tok[]): RemovedReason | null {
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === "url" && !safeUrlTarget(tk.target)) return "remote-url";
    if (tk.t === "function") {
      if (SCRIPT_FUNCTIONS.has(tk.name)) return "script";
      // attr(data-x url) (CSS Values 5) turns an attribute into a URL: never allowed.
      if (tk.name === "attr") {
        for (let m = k + 1, d = 1; m < toks.length && d > 0; m++) {
          const x = toks[m];
          if (x.t === "(" || x.t === "function") d++;
          else if (x.t === ")") d--;
          else if (x.t === "ident" && (x.name === "url" || x.name === "image")) return "remote-url";
        }
      }
      if (LOADING_FUNCTIONS.has(tk.name)) {
        // The first argument (a string, or the raw text up to the matching ")").
        let depth = 1;
        let arg = "";
        let stringOnly = true;
        for (let m = k + 1; m < toks.length && depth > 0; m++) {
          const x = toks[m];
          if (x.t === "(" || x.t === "function") depth++;
          else if (x.t === ")") depth--;
          if (depth <= 0) break;
          if (x.t === "string") arg += x.value;
          else if (x.t !== "ws" && x.t !== "comment") {
            stringOnly = false;
            arg += x.v;
          }
        }
        // image-set("a.png" 1x, …) and friends: every string inside must be safe.
        if (tk.name !== "url" && tk.name !== "src") {
          for (let m = k + 1, d = 1; m < toks.length && d > 0; m++) {
            const x = toks[m];
            if (x.t === "(" || x.t === "function") d++;
            else if (x.t === ")") d--;
            else if (x.t === "string" && !safeUrlTarget(x.value)) return "remote-url";
            else if (x.t === "url" && !safeUrlTarget(x.target)) return "remote-url";
          }
          continue;
        }
        if (!stringOnly || !safeUrlTarget(arg)) return "remote-url";
      }
    }
    // `url/**/(…)` is not a url() to the browser (it loads nothing), but drop it anyway: strict beats clever.
    if (tk.t === "ident" && (LOADING_FUNCTIONS.has(tk.name) || SCRIPT_FUNCTIONS.has(tk.name))) {
      const next = toks.slice(k + 1).find((x) => x.t !== "ws" && x.t !== "comment");
      if (next?.t === "(") return SCRIPT_FUNCTIONS.has(tk.name) ? "script" : "remote-url";
    }
    if (tk.t === "ident" && SCRIPT_PROPERTIES.has(tk.name)) {
      const next = toks.slice(k + 1).find((x) => x.t !== "ws" && x.t !== "comment");
      if (next?.t === ":") return "script";
    }
  }
  return null;
}

const lineOf = (css: string, offset: number) => css.slice(0, offset).split("\n").length;

/** Remove everything in a snippet that could load from the network. */
export function sanitizeCss(input: string): SanitizeResult {
  const css = input.length > MAX_SNIPPET_BYTES ? input.slice(0, MAX_SNIPPET_BYTES) : input;
  const toks = tokenize(css);
  const removed: SanitizeResult["removed"] = [];
  let out = "";
  let offset = 0;
  const offsets: number[] = [];
  for (const tk of toks) {
    offsets.push(offset);
    offset += tk.v.length;
  }
  const text = (a: number, b: number) => toks.slice(a, b).map((x) => x.v).join("");
  let i = 0;
  // Units: an at-rule up to ";" or its block, a declaration up to ";" / "}", a prelude up to "{".
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === "at") {
      // @import / @document …: drop the rule (and a block, if it has one).
      let j = i + 1;
      while (j < toks.length && toks[j].t !== ";" && toks[j].t !== "{") j++;
      const prelude = toks.slice(i, j);
      const drop = DROP_AT_RULES.has(tk.name) || (tk.name === "namespace" && verdict(prelude) !== null) || verdict(prelude) !== null;
      if (drop) {
        let end = j;
        if (toks[j]?.t === "{") {
          let depth = 0;
          for (; end < toks.length; end++) {
            if (toks[end].t === "{") depth++;
            else if (toks[end].t === "}" && --depth === 0) break;
          }
        }
        removed.push({ line: lineOf(css, offsets[i]), reason: tk.name === "import" ? "import" : tk.name === "namespace" || DROP_AT_RULES.has(tk.name) ? "at-rule" : "remote-url", text: text(i, Math.min(j + 1, toks.length)).trim().slice(0, 120) });
        i = Math.min(end + 1, toks.length);
        continue;
      }
      out += text(i, j);
      i = j;
      continue;
    }
    if (tk.t === "{" || tk.t === "}" || tk.t === ";" || tk.t === "ws" || tk.t === "comment") {
      out += tk.v;
      i++;
      continue;
    }
    // A declaration or a selector: up to the next ";", "{" or "}" at depth 0.
    let j = i;
    let depth = 0;
    while (j < toks.length) {
      const x = toks[j];
      if (x.t === "(" || x.t === "function") depth++;
      else if (x.t === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (x.t === ";" || x.t === "{" || x.t === "}")) break;
      j++;
    }
    const unit = toks.slice(i, j);
    const why = verdict(unit);
    if (why) {
      removed.push({ line: lineOf(css, offsets[i]), reason: why, text: text(i, j).trim().slice(0, 120) });
      if (toks[j]?.t === "{") {
        // A selector that loads something (it can't, but be strict): drop the whole rule.
        let d = 0;
        for (; j < toks.length; j++) {
          if (toks[j].t === "{") d++;
          else if (toks[j].t === "}" && --d === 0) break;
        }
        i = j + 1;
      } else i = toks[j]?.t === ";" ? j + 1 : j;
      continue;
    }
    out += text(i, j);
    i = j;
  }
  return { css: out, removed };
}
