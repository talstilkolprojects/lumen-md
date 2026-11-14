/**
 * TypeScript code blocks in a Markdown document — the units the in-editor
 * type checker analyses (see ./tsService and ../editor/tsCheckExtension).
 * Pure: no DOM, no TypeScript import.
 */
import { tokenize, topLevelNames } from "../plugins/liveJsScope";
import { functionScopes, matchBrackets, templateExpressions, METHOD_PREFIXES, isClassBody } from "./jsScopes";

export interface TsBlock {
  /** Stable per position in the document: `block-<n>`. */
  id: string;
  /** `.tsx` / `.jsx` blocks allow JSX. */
  tsx: boolean;
  /** JavaScript (```js / ```live-js): syntax always, types with `// @ts-check`. */
  js: boolean;
  /** A ```live-js block: it runs inside an async function (top-level `return` / `await`). */
  live: boolean;
  /** `live-js shared[=name]` blocks share one global scope per name. */
  scope: string | null;
  /** Offset of the first code character in the document. */
  from: number;
  /** Offset just past the last code character. */
  to: number;
  code: string;
}

const TS_LANGS = new Set(["ts", "typescript", "mts", "cts", "tsx"]);
const JS_LANGS = new Set(["js", "javascript", "mjs", "cjs", "jsx", "live-js", "js-live"]);
/** Fences that run as live-js (and so accept `shared`). */
const LIVE_JS_LANGS = new Set(["live-js", "js-live"]);
// Info string: a backtick fence's may not contain backticks (CommonMark);
// a tilde fence's may.
const OPEN_RE = /^ {0,3}(?:(`{3,})\s*([^\s`]*)([^`]*)|(~{3,})\s*(\S*)(.*))$/;
const SHARED_RE = /(?:^|\s)shared(?:=([\w-]+))?(?=\s|$)/;

/** Fenced ```ts / ```typescript / ```tsx blocks, in document order. */
export function findTsBlocks(doc: string): TsBlock[] {
  const out: TsBlock[] = [];
  let pos = 0;
  let open: { char: string; len: number; lang: string; meta: string; codeFrom: number } | null = null;
  while (pos <= doc.length) {
    const nl = doc.indexOf("\n", pos);
    const end = nl === -1 ? doc.length : nl;
    const line = doc.slice(pos, end);
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        const js = JS_LANGS.has(open.lang);
        if (TS_LANGS.has(open.lang) || js) {
          // Code ends before the newline that precedes the closing fence.
          const to = Math.max(open.codeFrom, pos - 1);
          const shared = LIVE_JS_LANGS.has(open.lang) ? SHARED_RE.exec(open.meta) : null;
          out.push({
            id: `block-${out.length}`,
            tsx: open.lang === "tsx" || open.lang === "jsx",
            js,
            live: LIVE_JS_LANGS.has(open.lang),
            scope: shared ? (shared[1] ?? "default") : null,
            from: open.codeFrom,
            to,
            code: doc.slice(open.codeFrom, to),
          });
        }
        open = null;
      }
    } else {
      const m = OPEN_RE.exec(line);
      if (m) {
        const fence = m[1] ?? m[4];
        open = {
          char: fence[0],
          len: fence.length,
          lang: (m[2] ?? m[5] ?? "").toLowerCase(),
          meta: (m[1] ? m[3] : m[6]) ?? "",
          codeFrom: nl === -1 ? doc.length : nl + 1,
        };
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  // An unclosed fence runs to the end of the document (CommonMark) — a
  // block still being typed is checked too.
  if (open && (TS_LANGS.has(open.lang) || JS_LANGS.has(open.lang)) && open.codeFrom <= doc.length) {
    const shared = LIVE_JS_LANGS.has(open.lang) ? SHARED_RE.exec(open.meta) : null;
    out.push({
      id: `block-${out.length}`,
      tsx: open.lang === "tsx" || open.lang === "jsx",
      js: JS_LANGS.has(open.lang),
      live: LIVE_JS_LANGS.has(open.lang),
      scope: shared ? (shared[1] ?? "default") : null,
      from: open.codeFrom,
      to: doc.length,
      code: doc.slice(open.codeFrom),
    });
  }
  return out;
}

/** The block containing document offset `pos` (inclusive end), or null. */
export function blockAt(blocks: readonly TsBlock[], pos: number): TsBlock | null {
  return blocks.find((b) => pos >= b.from && pos <= b.to) ?? null;
}

/**
 * A file the language service checks. A plain block is its own unit. A
 * `live-js shared` block is checked in a unit made of every EARLIER block
 * of its scope followed by itself — the state it sees at run time:
 *
 *  - later blocks are not part of it, so their declarations are invisible
 *    (running this block first would throw a ReferenceError too);
 *  - parts are joined with a statement boundary (`;`), as each block is a
 *    separate run — semicolonless code can't merge across blocks;
 *  - a name an earlier block declares and a later one re-declares is
 *    renamed in the earlier parts, so references use the newest
 *    declaration's type, as the runtime replaces the value;
 *  - only the unit's own block decides `// @ts-check`: directives in the
 *    earlier parts are neutralised and the unit gets its own header.
 *
 * Diagnostics, hover and completion only use the unit's own (last) part;
 * `parts` maps file offsets back to blocks.
 */
export interface TsUnit {
  id: string;
  code: string;
  tsx: boolean;
  js: boolean;
  shared: boolean;
  parts: Array<UnitPart>;
}

/** Where a block sits in a unit, and the length-changing edits made to its text. */
export interface UnitPart {
  block: TsBlock;
  offset: number;
  /** Edits in block-text coordinates, ascending: [from, to) replaced by `len` chars. */
  edits?: Array<{ from: number; to: number; len: number }>;
}

/** Block-text offset → offset in the edited text. */
function toEdited(part: UnitPart, x: number): number {
  let cum = 0;
  for (const e of part.edits ?? []) {
    if (x < e.from) break;
    if (x < e.to) return e.from + cum + Math.min(x - e.from, e.len);
    cum += e.len - (e.to - e.from);
  }
  return x + cum;
}

/** Offset in the edited text → block-text offset (inside an edit: its start). */
function fromEdited(part: UnitPart, u: number): number {
  let cum = 0;
  for (const e of part.edits ?? []) {
    if (u < e.from + cum) break;
    if (u < e.from + cum + e.len) return e.from;
    cum += e.len - (e.to - e.from);
  }
  return u - cum;
}

/**
 * live-js runs a block inside an async function, so a top-level `return`
 * or `await` is valid there: the unit's own block is checked the same way.
 * (Plain ```js fences stay modules.)
 */
const LIVE_WRAP_OPEN = "(async () => {\n";
const LIVE_WRAP_CLOSE = "\n})();";

/**
 * A shared live block runs inside an async function, so a top-level
 * `return` is valid there — but wrapping the block in the unit would make
 * its declarations local, unlike the runtime that hoists them to shared
 * globals. Instead each top-level `return` becomes a `throw` — it leaves
 * the block the same way, so narrowing after `if (!x) return;` still
 * holds: `return x` → `throw  x` (same length), a bare `return` →
 * `throw 0` (one longer, recorded as an edit for position mapping). Units
 * are modules, so top-level `await` needs nothing.
 */
function neutraliseTopLevelReturns(code: string): { text: string; edits: Array<{ from: number; to: number; len: number }> } {
  const tokens = tokenize(code);
  const scopes = functionScopes(tokens, matchBrackets(tokens));
  // Only a function or method body owns a `return`; a statement block that
  // declares a local (`if (stop) { const r = 1; return; }`) is a scope for
  // binding analysis but leaves the return top-level.
  const fns = scopes.filter((f) => !f.block);
  const edits: Array<{ from: number; to: number; len: number; text: string }> = [];
  tokens.forEach((t, i) => {
    if (t.type !== "ident" || t.value !== "return" || fns.some((f) => i >= f.from && i <= f.to)) return;
    const next = tokens[i + 1];
    const bare = !next || next.nl || (next.type === "punct" && (next.value === ";" || next.value === "}"));
    edits.push({ from: t.start, to: t.end, len: bare ? 7 : 6, text: bare ? "throw 0" : "throw " });
  });
  let text = code;
  for (const e of [...edits].reverse()) text = text.slice(0, e.from) + e.text + text.slice(e.to);
  return { text, edits: edits.filter((e) => e.len !== e.to - e.from).map(({ from, to, len }) => ({ from, to, len })) };
}

/** Joins the parts of a shared unit: ends any statement / line comment. */
const PART_SEPARATOR = "\n;\n";
const CHECK_HEADER = "// @ts-check\n";

/** Does the block opt into type checking (`// @ts-check` in its leading comments)? */
export function hasTsCheck(code: string): boolean {
  const lead = LEADING_COMMENTS_RE.exec(code)?.[0] ?? "";
  return /@ts-check\b/.test(lead) && !/@ts-nocheck\b/.test(lead);
}

/** The leading comments of a block (where TypeScript reads file directives). */
const LEADING_COMMENTS_RE = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

/** Neutralise `@ts-check` / `@ts-nocheck` in the leading comments only. */
function neutraliseDirectives(code: string): string {
  const lead = LEADING_COMMENTS_RE.exec(code)?.[0] ?? "";
  if (!lead) return code;
  return lead.replace(/@ts-(no)?check\b/g, (m) => "@ts-" + "_".repeat(m.length - 4)) + code.slice(lead.length);
}

/**
 * Rewrite an EARLIER part of a shared unit for the state a later block
 * sees, renaming the bindings in `names` (name → stand-in) where they are
 * evaluated while that block ran:
 *
 *  - at top level, in statement blocks, and inside functions that run
 *    right away (IIFEs, callbacks passed as arguments) → renamed: they
 *    read the value of that time;
 *  - inside retained closures (declared or assigned functions, methods,
 *    returned arrows) → kept: they run later and, like the runtime
 *    (shared names live on the global object), see the newest declaration;
 *  - names a function binds itself (parameters, its own name, local
 *    declarations) → kept, with their references;
 *  - property accesses (`o.name`), object keys (`{ name: 1 }`) and method
 *    names keep their name; a shorthand `{ name }` keeps its key and
 *    remaps only its value.
 *
 * Earlier parts are never mapped back to the document, so lengths may change.
 */
function rewriteEarlierPart(code: string, names: ReadonlyMap<string, string>, preserveLength = false): string {
  // The unit's own block keeps its directives (and so its offsets).
  const src = preserveLength ? code : neutraliseDirectives(code);
  if (names.size === 0) return src;
  const tokens = tokenize(src);
  const match = matchBrackets(tokens);
  const scopes = functionScopes(tokens, match);
  const edits: Array<{ from: number; to: number; text: string }> = [];
  const brackets: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.type === "punct") {
      if (tok.value === "{") brackets.push(isClassBody(tokens, k) ? "class" : "{");
      else if (tok.value === "[" || tok.value === "(") brackets.push(tok.value);
      else if (tok.value === "}" || tok.value === "]" || tok.value === ")") brackets.pop();
      continue;
    }
    if (tok.type === "tpl") {
      // `${ … }` expressions: rewrite them like code at this point, minus
      // names bound by enclosing functions; nothing inside a late-bound
      // closure.
      const around = scopes.filter((f) => k >= f.from && k <= f.to);
      if (around.some((f) => f.retained && !f.eager?.some(([a, b]) => k >= a && k <= b))) continue;
      const visible = new Map([...names].filter(([n]) => !around.some((f) => f.locals.has(n))));
      if (!visible.size) continue;
      for (const e of templateExpressions(tok.value)) {
        const rewritten = rewriteEarlierPart(e.code, visible, preserveLength);
        if (rewritten !== e.code) edits.push({ from: tok.start + e.offset, to: tok.start + e.offset + e.code.length, text: rewritten });
      }
      continue;
    }
    if (tok.type !== "ident") continue;
    const to = names.get(tok.value);
    if (!to) continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const prevP = prev?.type === "punct" ? prev.value : "";
    const nextP = next?.type === "punct" ? next.value : "";
    if (prevP === "." || prevP === "?.") continue;
    const top = brackets[brackets.length - 1];
    const inBraces = top === "{" || top === "class";
    const keyPos =
      inBraces &&
      (prevP === "{" || prevP === "," || prevP === ";" || prevP === "}" || prevP === "*" ||
        (prev?.type === "ident" && METHOD_PREFIXES.has(prev.value)));
    if (keyPos && (nextP === ":" || nextP === "(")) continue; // `{ name: … }`, `{ name() {} }`
    // A class member name (`value;`, `value = 1`, `static value`, last in
    // the body, or ending its line) is a key, never the shared binding.
    if (top === "class" && keyPos && (nextP === ";" || nextP === "=" || nextP === "}" || !next || next.nl)) continue;
    // A named function EXPRESSION's own name is local to it (a function
    // declaration's name is the shared binding itself).
    if (prev?.type === "ident" && prev.value === "function") {
      let c = k - 2;
      if (tokens[c]?.type === "ident" && tokens[c].value === "async") c--;
      const ctx = tokens[c];
      if (ctx && ((ctx.type === "punct" && ["=", ":", "(", ",", "?", "||", "&&", "??"].includes(ctx.value)) || (ctx.type === "ident" && ctx.value === "return"))) continue;
    }
    // Enclosing functions, innermost first.
    const enclosing = scopes.filter((f) => k >= f.from && k <= f.to).sort((x, y) => (y.from - x.from) || (x.to - y.to));
    const binder = enclosing.find((f) => f.locals.has(tok.value));
    if (binder) {
      // A recursive reference to a top-level function declaration is that
      // declaration's binding: it follows the rename. Anything else bound
      // inside is local.
      if (binder.selfName === tok.value) edits.push({ from: tok.start, to: tok.end, text: to });
      continue;
    }
    // Late-bound closure — except code a class body runs at definition.
    if (enclosing.some((f) => f.retained && !f.eager?.some(([a, b]) => k >= a && k <= b))) continue;
    const shorthand = keyPos && (nextP === "}" || nextP === "," || nextP === "=");
    // In the unit's own block offsets must not move: a shorthand keeps
    // the name (and its newest binding).
    if (shorthand && preserveLength) continue;
    edits.push({ from: tok.start, to: tok.end, text: shorthand ? `${tok.value}: ${to}` : to });
  }
  let out = src;
  for (let e = edits.length - 1; e >= 0; e--) out = out.slice(0, edits[e].from) + edits[e].text + out.slice(edits[e].to);
  return out;
}

/** Top-level `const` → `let  ` (length kept, so offsets don't move). */
function constAsLet(code: string): string {
  let out = code;
  for (const t of tokenize(code)) {
    if (t.type === "ident" && t.value === "const" && t.depth === 0) out = out.slice(0, t.start) + "let  " + out.slice(t.end);
  }
  return out;
}

/**
 * Offsets where a part re-declares a top-level name it already declared
 * (`let value = 1; let value = 'x'`): the shared runner turns both into
 * assignments, so code after the second declaration sees the new value.
 * Each cut starts a new version.
 */
function redeclarationCuts(code: string): number[] {
  const tokens = tokenize(code);
  // Top-level declaration statements, in order.
  const starts: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.depth !== 0 || t.type !== "ident") continue;
    const prev = tokens[i - 1];
    const atStart = !prev || t.nl || (prev.type === "punct" && (prev.value === ";" || prev.value === "}"));
    if (!atStart) continue;
    const kw = t.value === "async" && tokens[i + 1]?.value === "function" ? "function" : t.value;
    if (["let", "const", "var", "function", "class"].includes(kw)) starts.push(t.start);
  }
  // Each statement's names (every declarator and pattern binding): the
  // slice up to the next declaration holds just this one.
  const seen = new Set<string>();
  const cuts: number[] = [];
  starts.forEach((from, n) => {
    const names = topLevelNames(code.slice(from, starts[n + 1] ?? code.length));
    if (from > 0 && names.some((name) => seen.has(name))) cuts.push(from);
    for (const name of names) seen.add(name);
  });
  return cuts;
}

/** Same-length stand-in for `name`, unused in the unit (own block only). */
function sameLengthName(name: string, taken: Set<string>): string {
  const alphabet = "$_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let pos = name.length - 1; pos >= 0; pos--) {
    for (const ch of alphabet) {
      if (pos === 0 && ch >= "0" && ch <= "9") continue;
      const cand = name.slice(0, pos) + ch + name.slice(pos + 1);
      if (cand !== name && !taken.has(cand)) return cand;
    }
  }
  return name; // every variant taken: leave it (diagnostics may be imprecise)
}

function sharedUnit(scope: readonly TsBlock[], k: number): TsUnit {
  const own = scope[k];
  // Every part is split at its own re-declarations into segments; each
  // segment is one version step. seg = [part, from, to].
  const segs: Array<{ part: number; from: number; to: number }> = [];
  scope.slice(0, k + 1).forEach((b, i) => {
    const cuts = redeclarationCuts(b.code);
    let from = 0;
    for (const c of cuts) {
      segs.push({ part: i, from, to: c });
      from = c;
    }
    segs.push({ part: i, from, to: b.code.length });
  });
  // For each name: the segments that declare it, in order.
  const declaredIn = new Map<string, number[]>();
  segs.forEach((g, i) => {
    for (const n of topLevelNames(scope[g.part].code.slice(g.from, g.to))) {
      const at = declaredIn.get(n) ?? [];
      if (at[at.length - 1] !== i) at.push(i);
      declaredIn.set(n, at);
    }
  });
  // One stand-in per superseded VERSION (declaring segment), unique against
  // every identifier in the unit's parts (nested bindings included):
  // `name$prev`, `name$prev2`, … — or, inside the unit's own block, a
  // same-length name so its offsets don't move.
  const allIdents = new Set<string>();
  for (const b of scope.slice(0, k + 1)) for (const t of tokenize(b.code)) if (t.type === "ident") allIdents.add(t.value);
  const used = new Set<string>();
  const versions = new Map<string, string>();
  const standIn = (name: string, seg: number): string => {
    const key = `${name}@${seg}`;
    let m = versions.get(key);
    if (!m) {
      if (segs[seg].part === k) m = sameLengthName(name, new Set([...allIdents, ...used]));
      else {
        m = `${name}$prev`;
        for (let n = 2; allIdents.has(m) || used.has(m); n++) m = `${name}$prev${n}`;
      }
      used.add(m);
      versions.set(key, m);
    }
    return m;
  };
  /** Segment i's renames: each superseded name → the version visible to it. */
  const renamesFor = (i: number): Map<string, string> => {
    const rename = new Map<string, string>();
    for (const [n, at] of declaredIn) {
      const newest = at[at.length - 1];
      if (newest <= i) continue; // segment i already sees the final version
      const visible = [...at].reverse().find((d) => d <= i) ?? at[0];
      rename.set(n, standIn(n, visible));
    }
    return rename;
  };

  let code = hasTsCheck(own.code) ? CHECK_HEADER : "";
  const parts: TsUnit["parts"] = [];
  for (let i = 0; i <= k; i++) {
    const b = scope[i];
    if (i > 0) code += PART_SEPARATOR;
    let text = "";
    segs.forEach((g, si) => {
      if (g.part !== i) return;
      const piece = b.code.slice(g.from, g.to);
      const last = si === segs.length - 1;
      text += last ? piece : rewriteEarlierPart(piece, renamesFor(si), i === k);
    });
    // Shared runs turn top-level bindings into reassignable globals
    // (liveJsScope.hoistTopLevelBindings): `const` → `let`, same length.
    text = constAsLet(text);
    let edits: UnitPart["edits"];
    if (b.live) ({ text, edits } = neutraliseTopLevelReturns(text));
    parts.push({ block: b, offset: code.length, ...(i === k && edits?.length ? { edits } : {}) });
    code += text;
  }
  return { id: own.id, code, tsx: false, js: true, shared: true, parts };
}

export function toUnits(blocks: readonly TsBlock[]): TsUnit[] {
  const units: TsUnit[] = [];
  const scopes = new Map<string, TsBlock[]>();
  for (const b of blocks) {
    if (!b.scope) {
      // The wrapper would push `// @ts-check` out of the leading comments.
      const open = b.live ? (hasTsCheck(b.code) ? CHECK_HEADER : "") + LIVE_WRAP_OPEN : "";
      const code = b.live ? open + b.code + LIVE_WRAP_CLOSE : b.code;
      units.push({ id: b.id, code, tsx: b.tsx, js: b.js, shared: false, parts: [{ block: b, offset: open.length }] });
      continue;
    }
    let scope = scopes.get(b.scope);
    if (!scope) scopes.set(b.scope, (scope = []));
    scope.push(b);
    units.push(sharedUnit(scope, scope.length - 1));
  }
  return units;
}

/** The unit's own block (the one its diagnostics and positions belong to). */
export function ownPart(unit: TsUnit): UnitPart {
  return unit.parts[unit.parts.length - 1];
}

/**
 * Document range of a unit-relative range in the unit's own block
 * (clamped to it), or null when it lies in an earlier part.
 */
export function unitRangeToDoc(
  unit: TsUnit,
  start: number,
  length: number,
): { from: number; to: number } | null {
  const part = ownPart(unit);
  const { block, offset } = part;
  const editedLen = toEdited(part, block.code.length);
  if (start < offset || start > offset + editedLen) return null;
  const from = block.from + fromEdited(part, start - offset);
  const end = block.from + fromEdited(part, start - offset + Math.max(length, 1));
  const to = Math.min(Math.max(end, from + 1), block.to);
  return to > from ? { from, to } : { from, to: Math.min(from + 1, block.to + 1) };
}

/** The unit and unit-relative offset for a document position, or null. */
export function unitAt(units: readonly TsUnit[], pos: number): { unit: TsUnit; offset: number } | null {
  for (const unit of units) {
    const part = ownPart(unit);
    const { block, offset } = part;
    if (pos >= block.from && pos <= block.to) return { unit, offset: offset + toEdited(part, pos - block.from) };
  }
  return null;
}
