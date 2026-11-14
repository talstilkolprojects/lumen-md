/**
 * Code Doctor, layers 2 and 3: diagnoseJson() and repairJson() (split out of
 * codeDoctor.ts, plan W4.11; it re-exports both). Pure: no DOM, no network.
 */
import type { Diagnostic, RepairPatch, RepairResult } from "./codeDoctorTypes";
import { tokenize, SMART_QUOTE_MAP } from "./jsonTokens";
import type { Token } from "./jsonTokens";

const SMART_QUOTE_RE = new RegExp(
  `[${Object.keys(SMART_QUOTE_MAP).join("")}]`,
  "g",
);

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
