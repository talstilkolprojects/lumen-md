/**
 * Code Doctor, layer 1: the tolerant JSON tokenizer (split out of
 * codeDoctor.ts, plan W4.11; it re-exports tokenize, Token and TokenKind).
 * It does not throw on stray characters, smart quotes or unicode.
 */

// ── Smart-quote map (deterministic, high confidence) ────────────────

export const SMART_QUOTE_MAP: Record<string, string> = {
  "“": '"', // “
  "”": '"', // ”
  "„": '"', // „
  "‟": '"', // ‟
  "‘": "'", // ‘
  "’": "'", // ’
  "‚": "'", // ‚
  "‛": "'", // ‛
  "«": '"', // «
  "»": '"', // »
};

// ── Tolerant tokenizer ──────────────────────────────────────────────

export type TokenKind =
  | "lbrace"
  | "rbrace"
  | "lbracket"
  | "rbracket"
  | "colon"
  | "comma"
  | "string"
  | "number"
  | "bool"
  | "null"
  | "ident"
  | "newline"
  | "ws"
  | "comment"
  | "error";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Raw text of the token, untouched. */
  raw: string;
  /** Quote style for strings: '"' | "'" | "smart" | undefined. */
  quote?: '"' | "'" | "smart";
  /** Whether the string was properly terminated. */
  terminated?: boolean;
}

const NUM_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;

/**
 * Walks the input once and returns every meaningful token. Skips
 * whitespace except for newlines (which JSONL detection cares about).
 * Survives any input — never throws.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);

    // Newline (\n or \r\n)
    if (c === 10 || c === 13) {
      const start = i;
      if (c === 13 && text.charCodeAt(i + 1) === 10) i += 2;
      else i += 1;
      out.push({ kind: "newline", start, end: i, raw: text.slice(start, i) });
      continue;
    }
    // Whitespace
    if (c === 9 || c === 32) {
      const start = i;
      while (i < n && (text.charCodeAt(i) === 9 || text.charCodeAt(i) === 32)) i++;
      out.push({ kind: "ws", start, end: i, raw: text.slice(start, i) });
      continue;
    }
    // Comments (JSON5-style — // line, /* block */). Surface as `comment`
    // so the repairer can strip them in JSON-strict mode.
    if (c === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
      const start = i;
      while (i < n && text.charCodeAt(i) !== 10) i++;
      out.push({ kind: "comment", start, end: i, raw: text.slice(start, i) });
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const start = i;
      i += 2;
      while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47))
        i++;
      if (i < n) i += 2;
      out.push({ kind: "comment", start, end: i, raw: text.slice(start, i) });
      continue;
    }
    // Structural punctuation
    if (c === 123) {
      out.push({ kind: "lbrace", start: i, end: i + 1, raw: "{" });
      i++;
      continue;
    }
    if (c === 125) {
      out.push({ kind: "rbrace", start: i, end: i + 1, raw: "}" });
      i++;
      continue;
    }
    if (c === 91) {
      out.push({ kind: "lbracket", start: i, end: i + 1, raw: "[" });
      i++;
      continue;
    }
    if (c === 93) {
      out.push({ kind: "rbracket", start: i, end: i + 1, raw: "]" });
      i++;
      continue;
    }
    if (c === 58) {
      out.push({ kind: "colon", start: i, end: i + 1, raw: ":" });
      i++;
      continue;
    }
    if (c === 44) {
      out.push({ kind: "comma", start: i, end: i + 1, raw: "," });
      i++;
      continue;
    }
    // Strings — handle "...", '...', and smart quotes ".." / '..'
    const isStraightDouble = c === 34;
    const isStraightSingle = c === 39;
    const smartOpen = SMART_QUOTE_MAP[text[i]];
    if (isStraightDouble || isStraightSingle || smartOpen) {
      const start = i;
      const opener = text[i];
      const isDouble =
        isStraightDouble || smartOpen === '"';
      const quote: Token["quote"] = smartOpen
        ? "smart"
        : isStraightDouble
          ? '"'
          : "'";
      i++;
      let terminated = false;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        // Match closing — accept either the same opener, the matching
        // smart-quote pair, or for smart-open the canonical ASCII pair.
        if (
          ch === opener ||
          (smartOpen && SMART_QUOTE_MAP[ch] === smartOpen) ||
          (smartOpen && ch === (isDouble ? '"' : "'"))
        ) {
          i++;
          terminated = true;
          break;
        }
        // String content includes newlines under tolerant mode (we
        // surface unterminated strings via `terminated:false`).
        i++;
      }
      out.push({
        kind: "string",
        start,
        end: i,
        raw: text.slice(start, i),
        quote,
        terminated,
      });
      continue;
    }
    // Numbers
    NUM_RE.lastIndex = i;
    const numMatch = NUM_RE.exec(text);
    if (numMatch && numMatch.index === i) {
      out.push({
        kind: "number",
        start: i,
        end: i + numMatch[0].length,
        raw: numMatch[0],
      });
      i += numMatch[0].length;
      continue;
    }
    // Identifiers (keywords true/false/null + unquoted keys / NaN / Infinity)
    IDENT_RE.lastIndex = i;
    const idMatch = IDENT_RE.exec(text);
    if (idMatch && idMatch.index === i) {
      const word = idMatch[0];
      const kind: TokenKind =
        word === "true" || word === "false"
          ? "bool"
          : word === "null"
            ? "null"
            : "ident";
      out.push({ kind, start: i, end: i + word.length, raw: word });
      i += word.length;
      continue;
    }
    // Anything else — surface as a single-char error token so the
    // diagnoser can highlight it. We do NOT throw.
    out.push({
      kind: "error",
      start: i,
      end: i + 1,
      raw: text[i],
    });
    i++;
  }
  return out;
}
