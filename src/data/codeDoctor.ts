/**
 * Code Doctor — local repair engine for malformed JSON / JSONL.
 *
 * Three layers, in order:
 *   1. tokenize()         — tolerant tokenizer that doesn't throw on
 *                            stray characters, smart-quotes, or unicode.
 *   2. diagnoseJson()     — runs the token stream through a structural
 *                            check; emits typed Diagnostic[] with span
 *                            offsets so callers can highlight the source.
 *   3. repairJson()       — applies up to 6 deterministic repair
 *                            strategies, each with a confidence score.
 *
 * Plus two document-level utilities:
 *   - detectRawJsonRegions(markdown) — finds JSON/JSONL bodies that sit
 *     in plain markdown (outside any code fence) and returns ranges
 *     that the user might want to wrap in ```jsonl.
 *   - wrapInFence(markdown, region, lang) — non-destructive edit that
 *     adds opening/closing fence markers around a region.
 *
 * Pure: no React, no DOM, no network. The block component imports
 * this module; everything testable is here.
 */

// ── Types ────────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface SourceSpan {
  /** Start offset (UTF-16 chars) in the original input. */
  start: number;
  /** End offset, exclusive. */
  end: number;
}

export type DiagnosticCode =
  | "smart-quote"
  | "single-quote-string"
  | "trailing-comma"
  | "missing-comma"
  | "unquoted-key"
  | "unclosed-brace"
  | "unclosed-bracket"
  | "stray-token"
  | "empty-input"
  | "ok";

export interface Diagnostic {
  code: DiagnosticCode;
  span: SourceSpan;
  message: string;
  confidence: Confidence;
}

export interface RepairPatch {
  span: SourceSpan;
  replacement: string;
  reason: DiagnosticCode;
  confidence: Confidence;
}

export interface RepairResult {
  /** The repaired text (best-effort). Equal to input if nothing applied. */
  output: string;
  /** Patches applied, in original-text order. */
  patches: RepairPatch[];
  /** Diagnostics that survived the repair (if any). */
  remaining: Diagnostic[];
  /** True iff `JSON.parse(output)` succeeds. */
  parses: boolean;
}

// ── Smart-quote map (deterministic, high confidence) ────────────────

const SMART_QUOTE_MAP: Record<string, string> = {
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
const SMART_QUOTE_RE = new RegExp(
  `[${Object.keys(SMART_QUOTE_MAP).join("")}]`,
  "g",
);

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

// ── Structural diagnoser ────────────────────────────────────────────

/** Returns tokens minus whitespace/newlines (for the parser). */
function meaningful(tokens: Token[]): Token[] {
  return tokens.filter(
    (t) => t.kind !== "ws" && t.kind !== "newline" && t.kind !== "comment",
  );
}

/**
 * Walks the meaningful tokens and emits diagnostics for:
 *   - smart-quote strings
 *   - single-quote strings
 *   - unquoted object keys
 *   - trailing commas before `]` / `}`
 *   - missing commas between adjacent values
 *   - unclosed `{` / `[` (stack underflow / unconsumed)
 *   - stray characters (error tokens)
 *
 * Pure: just returns Diagnostic[]. Repair is a separate pass.
 */
export function diagnoseJson(text: string): Diagnostic[] {
  if (!text.trim()) {
    return [
      {
        code: "empty-input",
        span: { start: 0, end: text.length },
        message: "Input is empty.",
        confidence: "high",
      },
    ];
  }

  const tokens = tokenize(text);
  const out: Diagnostic[] = [];

  // Token-level diagnostics
  for (const t of tokens) {
    if (t.kind === "error") {
      out.push({
        code: "stray-token",
        span: { start: t.start, end: t.end },
        message: `Unexpected character ${JSON.stringify(t.raw)} — not valid JSON.`,
        confidence: "high",
      });
    } else if (t.kind === "string" && t.quote === "smart") {
      out.push({
        code: "smart-quote",
        span: { start: t.start, end: t.end },
        message:
          "Curly / smart quotes detected. JSON requires straight double quotes.",
        confidence: "high",
      });
    } else if (t.kind === "string" && t.quote === "'") {
      out.push({
        code: "single-quote-string",
        span: { start: t.start, end: t.end },
        message:
          "Single-quoted strings aren't valid JSON. Use double quotes.",
        confidence: "high",
      });
    }
  }

  // Structural pass
  const ms = meaningful(tokens);
  const stack: Array<{ kind: "obj" | "arr"; open: Token }> = [];
  const expectingKey: boolean[] = []; // parallel to stack — true when next obj token must be a key
  for (let k = 0; k < ms.length; k++) {
    const t = ms[k];
    const prev = k > 0 ? ms[k - 1] : null;
    const next = k + 1 < ms.length ? ms[k + 1] : null;

    if (t.kind === "lbrace") {
      stack.push({ kind: "obj", open: t });
      expectingKey.push(true);
    } else if (t.kind === "lbracket") {
      stack.push({ kind: "arr", open: t });
      expectingKey.push(false);
    } else if (t.kind === "rbrace" || t.kind === "rbracket") {
      // Trailing comma before close?
      if (prev?.kind === "comma") {
        out.push({
          code: "trailing-comma",
          span: { start: prev.start, end: prev.end },
          message: "Trailing comma before " + (t.kind === "rbrace" ? "}" : "]") + ".",
          confidence: "high",
        });
      }
      stack.pop();
      expectingKey.pop();
    } else if (t.kind === "ident") {
      // An identifier that isn't true/false/null in a key position is
      // an unquoted key (JSON5-style). Diagnose.
      const inObj = stack.length > 0 && stack[stack.length - 1].kind === "obj";
      const isKeyPos =
        inObj &&
        (prev?.kind === "lbrace" || prev?.kind === "comma");
      if (isKeyPos && next?.kind === "colon") {
        out.push({
          code: "unquoted-key",
          span: { start: t.start, end: t.end },
          message: `Object key "${t.raw}" is not quoted. JSON requires quoted keys.`,
          confidence: "high",
        });
      }
    } else if (t.kind === "comma") {
      // Diagnose double-comma → likely missing value, but we treat
      // double-comma as a missing-value (keep simple; the repairer
      // will resolve).
    }

    // Missing-comma detection: two value-tokens in a row with no
    // separator between them is illegal in arrays, and key-value pairs
    // in objects must also be separated. We only flag the simple case
    // where prev and t are both "values" and the parent is array/obj
    // and prev was not a structural token.
    if (prev) {
      const prevIsValue =
        prev.kind === "string" ||
        prev.kind === "number" ||
        prev.kind === "bool" ||
        prev.kind === "null" ||
        prev.kind === "rbrace" ||
        prev.kind === "rbracket";
      const thisIsValue =
        t.kind === "string" ||
        t.kind === "number" ||
        t.kind === "bool" ||
        t.kind === "null" ||
        t.kind === "lbrace" ||
        t.kind === "lbracket";
      if (prevIsValue && thisIsValue && stack.length > 0) {
        out.push({
          code: "missing-comma",
          span: { start: prev.end, end: t.start },
          message: "Missing comma between values.",
          confidence: "medium",
        });
      }
    }
  }

  // Anything left on the stack is unclosed.
  for (const open of stack) {
    out.push({
      code: open.kind === "obj" ? "unclosed-brace" : "unclosed-bracket",
      span: { start: open.open.start, end: open.open.end },
      message:
        open.kind === "obj"
          ? "Object opened with `{` is never closed."
          : "Array opened with `[` is never closed.",
      confidence: "low",
    });
  }

  return out;
}

// ── Repair engine ───────────────────────────────────────────────────

/**
 * Applies repairs in a fixed order. Each strategy is independent and
 * idempotent. We re-tokenize between strategies because earlier fixes
 * change offsets.
 *
 * Order:
 *   1. Smart quotes  → straight quotes
 *   2. Single quotes → double quotes (string literals only)
 *   3. Unquoted keys → quoted keys
 *   4. Trailing commas removed
 *   5. Missing commas inserted
 *   6. Unclosed brace/bracket appended
 */
export function repairJson(input: string): RepairResult {
  let text = input;
  const patches: RepairPatch[] = [];

  // Pass 1: smart quotes — global single-character replacements.
  if (SMART_QUOTE_RE.test(text)) {
    SMART_QUOTE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const local: RepairPatch[] = [];
    while ((m = SMART_QUOTE_RE.exec(text)) !== null) {
      const replacement = SMART_QUOTE_MAP[m[0]] ?? m[0];
      local.push({
        span: { start: m.index, end: m.index + m[0].length },
        replacement,
        reason: "smart-quote",
        confidence: "high",
      });
    }
    text = applyPatches(text, local);
    patches.push(...local);
  }

  // Pass 2: single-quoted strings → double-quoted.
  text = retokenizeAndPatch(text, patches, (toks) => {
    const local: RepairPatch[] = [];
    for (const t of toks) {
      if (t.kind === "string" && t.quote === "'") {
        // Re-emit as JSON string: read the inner content, re-encode safely.
        const inner = t.raw.slice(1, t.raw.length - (t.terminated ? 1 : 0));
        const decoded = decodeJsLooseString(inner);
        const reencoded = JSON.stringify(decoded);
        local.push({
          span: { start: t.start, end: t.end },
          replacement: reencoded,
          reason: "single-quote-string",
          confidence: "high",
        });
      }
    }
    return local;
  });

  // Pass 3: unquoted keys → quoted.
  text = retokenizeAndPatch(text, patches, (toks) => {
    const ms = meaningful(toks);
    const local: RepairPatch[] = [];
    const stack: Array<"obj" | "arr"> = [];
    for (let k = 0; k < ms.length; k++) {
      const t = ms[k];
      const prev = k > 0 ? ms[k - 1] : null;
      const next = k + 1 < ms.length ? ms[k + 1] : null;
      if (t.kind === "lbrace") stack.push("obj");
      else if (t.kind === "lbracket") stack.push("arr");
      else if (t.kind === "rbrace" || t.kind === "rbracket") stack.pop();
      else if (
        t.kind === "ident" &&
        stack.length > 0 &&
        stack[stack.length - 1] === "obj" &&
        (prev?.kind === "lbrace" || prev?.kind === "comma") &&
        next?.kind === "colon"
      ) {
        local.push({
          span: { start: t.start, end: t.end },
          replacement: JSON.stringify(t.raw),
          reason: "unquoted-key",
          confidence: "high",
        });
      }
    }
    return local;
  });

  // Pass 4: trailing commas — drop the comma when the next meaningful
  // token is `}` or `]`.
  text = retokenizeAndPatch(text, patches, (toks) => {
    const ms = meaningful(toks);
    const local: RepairPatch[] = [];
    for (let k = 0; k < ms.length - 1; k++) {
      const cur = ms[k];
      const next = ms[k + 1];
      if (
        cur.kind === "comma" &&
        (next.kind === "rbrace" || next.kind === "rbracket")
      ) {
        local.push({
          span: { start: cur.start, end: cur.end },
          replacement: "",
          reason: "trailing-comma",
          confidence: "high",
        });
      }
    }
    return local;
  });

  // Pass 5: missing commas — between two adjacent value-tokens that
  // share a parent. Insert at the boundary; medium confidence.
  text = retokenizeAndPatch(text, patches, (toks) => {
    const ms = meaningful(toks);
    const local: RepairPatch[] = [];
    const stack: Array<"obj" | "arr"> = [];
    for (let k = 0; k < ms.length - 1; k++) {
      const cur = ms[k];
      const nxt = ms[k + 1];
      if (cur.kind === "lbrace") stack.push("obj");
      else if (cur.kind === "lbracket") stack.push("arr");
      else if (cur.kind === "rbrace" || cur.kind === "rbracket") stack.pop();
      const prevIsValue =
        cur.kind === "string" ||
        cur.kind === "number" ||
        cur.kind === "bool" ||
        cur.kind === "null" ||
        cur.kind === "rbrace" ||
        cur.kind === "rbracket";
      const nxtIsValue =
        nxt.kind === "string" ||
        nxt.kind === "number" ||
        nxt.kind === "bool" ||
        nxt.kind === "null" ||
        nxt.kind === "lbrace" ||
        nxt.kind === "lbracket";
      if (prevIsValue && nxtIsValue && stack.length > 0) {
        local.push({
          span: { start: cur.end, end: cur.end },
          replacement: ",",
          reason: "missing-comma",
          confidence: "medium",
        });
      }
    }
    return local;
  });

  // Pass 6: unclosed structures — append matching closers in reverse
  // order. Low confidence: we don't know if the structure was supposed
  // to extend further or end here. If the last meaningful token before
  // EOF is a comma, drop it first so we don't create `..,}` / `..,]`.
  text = retokenizeAndPatch(text, patches, (toks) => {
    const ms = meaningful(toks);
    const stack: Array<"obj" | "arr"> = [];
    for (const t of ms) {
      if (t.kind === "lbrace") stack.push("obj");
      else if (t.kind === "lbracket") stack.push("arr");
      else if (t.kind === "rbrace" || t.kind === "rbracket") stack.pop();
    }
    if (stack.length === 0) return [];
    const closers = stack
      .reverse()
      .map((k) => (k === "obj" ? "}" : "]"))
      .join("");
    const local: RepairPatch[] = [];
    const last = ms[ms.length - 1];
    if (last?.kind === "comma") {
      local.push({
        span: { start: last.start, end: last.end },
        replacement: "",
        reason: "trailing-comma",
        confidence: "high",
      });
    }
    local.push({
      span: { start: text.length, end: text.length },
      replacement: closers,
      reason:
        stack[stack.length - 1] === "obj"
          ? "unclosed-brace"
          : "unclosed-bracket",
      confidence: "low",
    });
    return local;
  });

  // Pass 7: final sweep for any trailing commas that emerged after
  // unclosed-bracket repairs added the closing token.
  text = retokenizeAndPatch(text, patches, (toks) => {
    const ms = meaningful(toks);
    const local: RepairPatch[] = [];
    for (let k = 0; k < ms.length - 1; k++) {
      const cur = ms[k];
      const next = ms[k + 1];
      if (
        cur.kind === "comma" &&
        (next.kind === "rbrace" || next.kind === "rbracket")
      ) {
        local.push({
          span: { start: cur.start, end: cur.end },
          replacement: "",
          reason: "trailing-comma",
          confidence: "high",
        });
      }
    }
    return local;
  });

  let parses = false;
  try {
    JSON.parse(text);
    parses = true;
  } catch {
    /* why: leave parses=false; remaining[] surfaces what's left */
  }

  return {
    output: text,
    patches,
    remaining: parses ? [] : diagnoseJson(text),
    parses,
  };
}

function applyPatches(text: string, patches: RepairPatch[]): string {
  if (patches.length === 0) return text;
  // Apply right-to-left so earlier offsets stay valid.
  const sorted = [...patches].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const p of sorted) {
    out =
      out.slice(0, p.span.start) +
      p.replacement +
      out.slice(p.span.end);
  }
  return out;
}

function retokenizeAndPatch(
  text: string,
  accumulator: RepairPatch[],
  produce: (toks: Token[]) => RepairPatch[],
): string {
  const toks = tokenize(text);
  const local = produce(toks);
  if (local.length === 0) return text;
  accumulator.push(...local);
  return applyPatches(text, local);
}

function decodeJsLooseString(inner: string): string {
  // Decode JS-loose string body (single-quoted).
  // Handles \', \", \\, \n, \r, \t, \uXXXX, \xHH.
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      out += "\\";
      continue;
    }
    i++;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "0":
        out += "\0";
        break;
      case "'":
      case '"':
      case "\\":
      case "/":
        out += next;
        break;
      case "u": {
        const hex = inner.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += "u";
        }
        break;
      }
      case "x": {
        const hex = inner.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          out += "x";
        }
        break;
      }
      default:
        out += next;
    }
  }
  return out;
}

// ── JSONL line-boundary detection ──────────────────────────────────

export interface JsonlLine {
  /** 1-based line number. */
  line: number;
  /** Span of the line in the original text. */
  span: SourceSpan;
  /** Raw text of the line. */
  raw: string;
  /** Did this line parse standalone? */
  parses: boolean;
  /** Diagnostics for this line (only populated when !parses). */
  diagnostics: Diagnostic[];
}

/**
 * Treats the input as JSONL — one JSON value per non-blank line — and
 * returns per-line parse status. Skips blank lines silently.
 */
export function diagnoseJsonl(text: string): JsonlLine[] {
  const out: JsonlLine[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const start = offset;
    const end = start + raw.length;
    offset = end + 1; // +1 for the newline (off-by-one on \r\n irrelevant here)
    if (!raw.trim()) continue;
    let parses = false;
    let diagnostics: Diagnostic[] = [];
    try {
      JSON.parse(raw);
      parses = true;
    } catch {
      diagnostics = diagnoseJson(raw).map((d) => ({
        ...d,
        span: { start: start + d.span.start, end: start + d.span.end },
      }));
    }
    out.push({
      line: i + 1,
      span: { start, end },
      raw,
      parses,
      diagnostics,
    });
  }
  return out;
}

// ── Document-level: detect raw JSON in markdown outside fences ─────

export interface RawJsonRegion {
  /** Span in the original markdown text. */
  span: SourceSpan;
  /** Best-effort detection: "json", "jsonl", or "json-array". */
  kind: "json" | "jsonl" | "json-array";
  /** First few characters of the region (for UI preview). */
  preview: string;
  /** Confidence that this is actually JSON content. */
  confidence: Confidence;
}

const FENCE_RE = /^```/gm;
const JSONL_HINT = /^\s*\{[\s\S]*?\}\s*$/m;
const JSON_OBJ_HINT = /^\s*\{[\s\S]*\}\s*$/;
const JSON_ARR_HINT = /^\s*\[[\s\S]*\]\s*$/;

/**
 * Scans `markdown` for runs of text that look like JSON / JSONL but
 * sit OUTSIDE any code fence. Returns regions to offer wrapping for.
 *
 * Heuristic, intentionally conservative: only flags blocks where every
 * non-blank line is a parseable JSON value (JSONL) OR the whole block
 * is a single parseable JSON object/array. We do NOT flag scattered
 * inline JSON inside prose paragraphs.
 */
export function detectRawJsonRegions(markdown: string): RawJsonRegion[] {
  // Split on blank-line boundaries to get markdown "blocks", but track
  // absolute offsets so the spans we return refer to the original text.
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  const blockRe = /([\s\S]*?)(?:\n\s*\n|$)/g;
  let m: RegExpExecArray | null;
  let walked = 0;
  while ((m = blockRe.exec(markdown)) !== null && m.index === walked) {
    const block = m[1];
    if (block.length > 0) {
      blocks.push({
        start: m.index,
        end: m.index + block.length,
        text: block,
      });
    }
    walked = m.index + m[0].length;
    if (m[0].length === 0) break;
  }

  // Build a set of offsets that fall inside fenced code blocks; we'll
  // skip blocks that overlap a fence.
  const fenceRanges: Array<[number, number]> = [];
  FENCE_RE.lastIndex = 0;
  const fenceStarts: number[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = FENCE_RE.exec(markdown)) !== null) fenceStarts.push(fm.index);
  for (let i = 0; i + 1 < fenceStarts.length; i += 2) {
    fenceRanges.push([fenceStarts[i], fenceStarts[i + 1]]);
  }
  const inFence = (pos: number) =>
    fenceRanges.some(([s, e]) => pos >= s && pos < e);

  const out: RawJsonRegion[] = [];
  for (const b of blocks) {
    if (inFence(b.start)) continue;
    const trimmed = b.text.trim();
    if (trimmed.length < 8) continue; // too short to be meaningful

    // Case 1: whole block is a JSON object or array.
    if (JSON_OBJ_HINT.test(trimmed) || JSON_ARR_HINT.test(trimmed)) {
      try {
        JSON.parse(trimmed);
        out.push({
          span: { start: b.start, end: b.end },
          kind: JSON_ARR_HINT.test(trimmed) ? "json-array" : "json",
          preview: trimmed.slice(0, 80),
          confidence: "high",
        });
        continue;
      } catch {
        /* why: fall through to JSONL check */
      }
    }

    // Case 2: every non-blank line is a JSON value (JSONL).
    const lines = b.text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length >= 2 && lines.every((l) => JSONL_HINT.test(l))) {
      const allParse = lines.every((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      });
      if (allParse) {
        out.push({
          span: { start: b.start, end: b.end },
          kind: "jsonl",
          preview: lines[0].slice(0, 80),
          confidence: "high",
        });
        continue;
      }
      // At least it has the SHAPE of JSONL (each line a {...}). Surface
      // as a medium-confidence candidate; the user can repair via
      // Code Doctor.
      out.push({
        span: { start: b.start, end: b.end },
        kind: "jsonl",
        preview: lines[0].slice(0, 80),
        confidence: "medium",
      });
    }
  }
  return out;
}

/**
 * Returns a new markdown string with the region wrapped in a fenced
 * code block of language `lang`. Pure: original input unchanged.
 */
export function wrapInFence(
  markdown: string,
  region: SourceSpan,
  lang: string,
): string {
  const before = markdown.slice(0, region.start);
  const body = markdown.slice(region.start, region.end);
  const after = markdown.slice(region.end);
  const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
  const needsTrailingNewline = after.length > 0 && !after.startsWith("\n");
  return (
    before +
    (needsLeadingNewline ? "\n" : "") +
    "```" +
    lang +
    "\n" +
    body.replace(/\s+$/, "") +
    "\n```" +
    (needsTrailingNewline ? "\n" : "") +
    after
  );
}

/**
 * Predicate used by `CodeDoctorBlock` to decide whether to render the
 * inline DataTable preview after a successful repair.
 *
 * Returns true only when the value is an array of plain objects AND
 * every value in every record is scalar (string / number / boolean /
 * null). Skipping array-valued records avoids a misleading column
 * type: parseJSONTable's `inferType` stringifies arrays to "1,2,3",
 * which Date.parse can return a real number for on some engines —
 * causing an `items` column of arrays to be typed as DATE.
 *
 * Lives in the engine module (not in the React block) so it's
 * unit-testable without mounting the UI.
 */
export function isAllScalarRecordList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const r of value) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
    for (const v of Object.values(r as Record<string, unknown>)) {
      if (
        v !== null &&
        typeof v !== "string" &&
        typeof v !== "number" &&
        typeof v !== "boolean"
      ) {
        return false;
      }
    }
  }
  return true;
}
