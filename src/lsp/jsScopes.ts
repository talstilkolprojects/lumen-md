/**
 * The function-scope scanner behind tsBlocks.ts (split out of it, plan W4.11):
 * where each function body starts and ends in a JavaScript/TypeScript block,
 * bracket matching and template-literal expressions, on the liveJsScope
 * tokens. Pure: no DOM, no TypeScript import.
 */
import { tokenize } from "../plugins/liveJsScope";

/** Words before `(` that make the following `{` a statement block, not a function body. */
const BLOCK_HEADS = new Set(["if", "while", "for", "with", "switch", "catch"]);
/** Words that may precede a method name in an object literal or class body. */
export const METHOD_PREFIXES = new Set(["get", "set", "static", "async"]);

interface FnScope {
  /** Token range [from, to] covering parameters and body. */
  from: number;
  to: number;
  /**
   * Retained closure (declared, assigned, a method, returned): it runs
   * later, so it sees the newest declaration. Otherwise it is passed as an
   * argument or invoked in place (IIFE, `.map(x => …)`): it runs while the
   * block is evaluated and sees that time's value.
   */
  retained: boolean;
  /** Names bound inside it: parameters, its own name, local declarations. */
  locals: Set<string>;
  /**
   * A top-level function DECLARATION whose name nothing else inside binds:
   * references to it inside the body are the declaration's binding (the
   * runner keeps it in the block's own scope), so they follow its rename.
   */
  selfName?: string;
  /**
   * Class bodies only: ranges evaluated when the class is defined (static
   * initializers, static blocks, computed keys) — not late-bound.
   */
  eager?: Array<[number, number]>;
  /** A statement block `{ … }` (not a function): scopes bindings, not `return`. */
  block?: boolean;
}

/** Does the `{` at `i` open a class body (`class X [extends Y] {`)? */
export function isClassBody(tokens: ReturnType<typeof tokenize>, i: number): boolean {
  for (let j = i - 1, depth = 0; j >= 0 && i - j < 64; j--) {
    const t = tokens[j];
    if (t.type === "punct") {
      if (t.value === ")" || t.value === "]") depth++;
      else if (t.value === "(" || t.value === "[") depth--;
      else if (depth === 0 && (t.value === ";" || t.value === "{" || t.value === "}" || t.value === "=>")) return false;
      continue;
    }
    if (depth === 0 && t.type === "ident" && t.value === "class") return true;
  }
  return false;
}

/** Index of the matching bracket for every `(`, `[`, `{` and its closer. */
export function matchBrackets(tokens: ReturnType<typeof tokenize>): Map<number, number> {
  const match = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    if (t.type !== "punct") return;
    if (t.value === "(" || t.value === "[" || t.value === "{") stack.push(i);
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        match.set(open, i);
        match.set(i, open);
      }
    }
  });
  return match;
}

/** Callees that invoke their callback argument before returning. */
const SYNC_CALLBACK_METHODS = new Set([
  "map", "filter", "forEach", "reduce", "reduceRight", "some", "every", "find", "findIndex",
  "findLast", "findLastIndex", "flatMap", "sort", "toSorted", "from", "replace", "replaceAll",
  "groupBy", "fromEntries",
]);

/** Find function scopes (functions, arrows, methods) in a token list. */
export function functionScopes(tokens: ReturnType<typeof tokenize>, match: Map<number, number>): FnScope[] {
  const scopes: FnScope[] = [];
  const pending: Array<() => FnScope> = [];
  const val = (i: number) => (tokens[i]?.type === "punct" || tokens[i]?.type === "ident" ? tokens[i].value : "");
  const isPunct = (i: number, v: string) => tokens[i]?.type === "punct" && tokens[i].value === v;
  /** Retained unless the function sits in argument / IIFE position. */
  const CALLEE_END = new Set([")", "]"]);
  const NOT_CALLEE = new Set(["return", "typeof", "void", "delete", "await", "yield", "in", "of", "new", "case", "else", "do"]);
  /**
   * A callback passed to the call whose `(` is at `open`: run now only when
   * the callee is known to call it synchronously (array / string helpers,
   * `new Promise(executor)`); anything else may keep it for later
   * (`callbacks.push(fn)`, `setTimeout`, event listeners, `.then`).
   */
  /**
   * The declarators of the `const` / `let` / `var` at `kw`: each binding's
   * first token (an identifier or a pattern's `{` / `[`) and, when it has
   * one, its initializer's first token.
   */
  const declarators = (kw: number): Array<{ at: number; init?: number }> => {
    const out: Array<{ at: number; init?: number }> = [];
    for (let j = kw + 1; j < tokens.length; ) {
      const t = tokens[j];
      if (!(t.type === "ident" || isPunct(j, "{") || isPunct(j, "["))) break;
      const bindEnd = t.type === "ident" ? j : (match.get(j) ?? j);
      if (!isPunct(bindEnd + 1, "=")) {
        out.push({ at: j });
        if (!isPunct(bindEnd + 1, ",")) break;
        j = bindEnd + 2;
        continue;
      }
      out.push({ at: j, init: bindEnd + 2 });
      // Skip the initializer to a `,` at this level (the next declarator),
      // or stop at its end: `;`, an enclosing closer, or a new line that
      // starts with a word after a complete expression (ASI).
      let e = bindEnd + 2;
      for (; e < tokens.length; e++) {
        const x = tokens[e];
        if (e > bindEnd + 2 && x.nl && x.type === "ident" && !["in", "instanceof", "of"].includes(x.value)) {
          const p = tokens[e - 1];
          if (p.type !== "punct" || [")", "]", "}"].includes(p.value)) break;
        }
        if (x.type !== "punct") continue;
        if (x.value === "(" || x.value === "[" || x.value === "{") e = match.get(e) ?? e;
        else if (x.value === "," || x.value === ";" || x.value === ")" || x.value === "]" || x.value === "}") break;
      }
      if (!isPunct(e, ",")) break;
      j = e + 1;
    }
    return out;
  };
  // Bindings visibly initialised with an array / string literal (`const xs
  // = [0]`, `let s = "a"`): their `.map` / `.replace` are the built-ins. Each
  // declaration of a name is kept with the brace range it is visible in, so
  // a receiver resolves to its own binding, not a same-named one elsewhere.
  // (Built lazily: `var` scoping needs every function body known.)
  let literalDecls: Map<string, Array<{ from: number; to: number; kind?: "array" | "string"; pos: number }>> | null = null;
  const literalDeclsFor = () => {
    if (literalDecls) return literalDecls;
    const decls = new Map<string, Array<{ from: number; to: number; kind?: "array" | "string"; pos: number }>>();
    const braces: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (isPunct(i, "{")) braces.push(i);
      else if (isPunct(i, "}")) braces.pop();
      const kw = val(i);
      if (tokens[i].type !== "ident" || (kw !== "const" && kw !== "let" && kw !== "var")) continue;
      // `let` / `const`: the enclosing braces; `var`: the enclosing function body.
      let from = -1;
      let to = tokens.length;
      if (kw === "var") {
        for (const [a, b] of fnBodies) if (a < i && i < b && a > from) [from, to] = [a, b];
      } else if (braces.length) {
        from = braces[braces.length - 1];
        to = match.get(from) ?? tokens.length;
      }
      for (const d of declarators(i)) {
        const names = new Set<string>();
        if (tokens[d.at].type === "ident") names.add(tokens[d.at].value);
        else addPatternBindings(names, d.at);
        let kind: "array" | "string" | undefined;
        if (tokens[d.at].type === "ident" && d.init !== undefined) {
          const init = tokens[d.init];
          if (isPunct(d.init, "[")) kind = "array";
          else if (init?.type === "str" || init?.type === "tpl") kind = "string";
        }
        for (const n of names) {
          const at = decls.get(n) ?? [];
          at.push({ from, to, kind, pos: d.at });
          decls.set(n, at);
        }
      }
    }
    // A parameter binds its name over the whole function (A6): inside it,
    // `xs.map` is the argument's, not an outer `const xs = […]`'s.
    for (const f of paramScopes) {
      for (const n of paramBindings(f.paramsFrom, f.paramsTo)) {
        const at = decls.get(n) ?? [];
        at.push({ from: f.paramsFrom, to: f.to, pos: f.paramsFrom });
        decls.set(n, at);
      }
    }
    return (literalDecls = decls);
  };
  /** The literal kind of the binding `name` that the token at `use` sees. */
  const literalKindAt = (name: string, use: number): "array" | "string" | undefined => {
    let best: { from: number; to: number; kind?: "array" | "string"; pos: number } | undefined;
    for (const d of literalDeclsFor().get(name) ?? []) {
      if (!(d.from < use && use < d.to)) continue;
      // Innermost scope wins; within one scope (`var xs; var xs = []`), the
      // latest declaration before the use.
      if (!best || d.from > best.from || (d.from === best.from && d.pos < use && (best.pos > use || d.pos > best.pos))) best = d;
    }
    return best?.kind;
  };
  // Where each such name is assigned again (`xs = holder`, `xs += …`): from
  // that point on it may no longer be the built-in. (Lazy, like the above.)
  let reassigned: Map<string, number> | null = null;
  const reassignedAt = () => {
    if (reassigned) return reassigned;
    reassigned = new Map<string, number>();
    for (let i = 1; i + 1 < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== "ident" || !literalDeclsFor().get(t.value)?.some((d) => d.kind) || reassigned.has(t.value)) continue;
      const next = tokens[i + 1];
      const prev = tokens[i - 1];
      const declared = prev?.type === "ident" && (prev.value === "const" || prev.value === "let" || prev.value === "var");
      if (declared || isPunct(i - 1, ".") || isPunct(i - 1, "?.")) continue;
      if (next?.type === "punct" && /^(=|\+=|-=|\|\|=|&&=|\?\?=)$/.test(next.value)) reassigned.set(t.value, i);
    }
    return reassigned;
  };
  // `Array` / `Object` / `Promise` are the built-ins only when the code
  // doesn't bind its own: a declaration or assignment anywhere, or a
  // parameter of a function the use sits in (A6). (Parameters are known
  // after the scan, so this is built lazily, like the above.)
  const declShadowed = new Set<string>();
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || (t.value !== "Array" && t.value !== "Object" && t.value !== "Promise")) continue;
    const prev = val(i - 1);
    if (["const", "let", "var", "function", "class"].includes(prev) || (isPunct(i + 1, "=") && !isPunct(i - 1, "."))) declShadowed.add(t.value);
  }
  let builtinParams: Array<{ from: number; to: number; names: Set<string> }> | null = null;
  const shadowedAt = (name: string, at: number): boolean => {
    if (declShadowed.has(name)) return true;
    builtinParams ??= paramScopes
      .map((f) => ({ from: f.paramsFrom, to: f.to, names: paramBindings(f.paramsFrom, f.paramsTo) }))
      .filter((f) => f.names.has("Array") || f.names.has("Object") || f.names.has("Promise"));
    return builtinParams.some((f) => at > f.from && at <= f.to && f.names.has(name));
  };
  const callbackRetained = (open: number): boolean => {
    const callee = tokens[open - 1];
    if (callee?.type !== "ident") return true;
    if (callee.value === "Promise" && val(open - 2) === "new" && !shadowedAt("Promise", open - 1)) return false;
    // `xs.map(…)` and `xs?.map(…)` alike.
    if (!SYNC_CALLBACK_METHODS.has(callee.value) || !(isPunct(open - 2, ".") || isPunct(open - 2, "?."))) return true;
    // Only when the receiver is known to be the built-in: an array literal
    // (`[…].map`), a string literal (`"…".replace`), `Array.from`,
    // `Object.fromEntries` / `Object.groupBy`. A user's own `holder.map`
    // may keep the callback.
    let end = open - 3;
    // Grouping parentheses (`([0]).map`, `(xs).map`) are transparent: the
    // receiver is what they enclose, if that is a single operand. A call's
    // parentheses (`f().map`) are not grouping.
    let groupStart = -1;
    while (isPunct(end, ")")) {
      const lo = match.get(end);
      if (lo === undefined) return true;
      const b = tokens[lo - 1];
      if (b && ((b.type === "ident" && !NOT_CALLEE.has(b.value)) || (b.type === "punct" && CALLEE_END.has(b.value)))) return true;
      groupStart = lo + 1;
      end--;
    }
    const recv = tokens[end];
    if (!recv) return true;
    const recvStart = isPunct(end, "]") ? (match.get(end) ?? -1) : end;
    if (groupStart !== -1 && recvStart !== groupStart) return true; // `(a + b).map`, …
    if (recv.type === "str" || recv.type === "tpl") return !(callee.value === "replace" || callee.value === "replaceAll");
    if (recv.type === "ident") {
      if (recv.value === "Array" && !shadowedAt("Array", end)) return callee.value !== "from";
      if (recv.value === "Object" && !shadowedAt("Object", end)) return !(callee.value === "fromEntries" || callee.value === "groupBy");
      const again = reassignedAt().get(recv.value);
      const member = isPunct(end - 1, ".") || isPunct(end - 1, "?.");
      const kind = member || (again !== undefined && again < open) ? undefined : literalKindAt(recv.value, end);
      if (kind === "string") return !(callee.value === "replace" || callee.value === "replaceAll");
      if (kind === "array") return callee.value === "replace" || callee.value === "replaceAll" || callee.value === "from" || callee.value === "fromEntries" || callee.value === "groupBy";
      return true;
    }
    if (isPunct(end, "]")) {
      const before = recvStart >= 0 ? tokens[recvStart - 1] : undefined;
      // `[…]` is a literal unless it indexes something (`a[0]`, `f()[0]`).
      const indexes = recvStart < 0 || (before && (before.type === "ident" || (before.type === "punct" && CALLEE_END.has(before.value))));
      return !!indexes;
    }
    return true;
  };
  const retainedAt = (before: number): boolean => {
    let c = before;
    if (val(c) === "async") c--;
    if (isPunct(c, ",")) {
      // A later argument: find the call's `(` and classify like the first.
      // A later argument (or array / object item): find the enclosing opener.
      let open = c - 1;
      while (open >= 0) {
        if ((isPunct(open, "(") || isPunct(open, "[") || isPunct(open, "{")) && (match.get(open) ?? -1) > c) break;
        open = isPunct(open, ")") || isPunct(open, "]") || isPunct(open, "}") ? (match.get(open) ?? open) - 1 : open - 1;
      }
      if (!isPunct(open, "(")) return true; // array / object item: kept for later
      const callee = tokens[open - 1];
      const isCall = callee && ((callee.type === "ident" && !NOT_CALLEE.has(callee.value)) || (callee.type === "punct" && CALLEE_END.has(callee.value)));
      return isCall ? callbackRetained(open) : true;
    }
    if (!isPunct(c, "(")) return true;
    // `( … )(…)`: an IIFE runs now.
    const close = match.get(c);
    if (close !== undefined && isPunct(close + 1, "(")) return false;
    const t = tokens[c - 1];
    if (t && ((t.type === "ident" && !NOT_CALLEE.has(t.value)) || (t.type === "punct" && CALLEE_END.has(t.value)))) {
      return callbackRetained(c);
    }
    // A grouping parenthesis: classify by what the group sits in.
    return retainedAt(c - 1);
  };
  /**
   * Identifiers a destructuring pattern at `open` binds: property keys and
   * whole default expressions (`{ x = (value) }`, `[a = f(value)]`) are
   * skipped; nested patterns recurse.
   */
  const addPatternBindings = (into: Set<string>, open: number) => {
    const close = match.get(open) ?? open;
    for (let m = open + 1; m < close; m++) {
      if (isPunct(m, "=")) {
        // Skip the default expression up to the next `,` / closer at this level.
        let depth = 0;
        for (m++; m < close; m++) {
          const v = tokens[m].type === "punct" ? tokens[m].value : "";
          if (v === "(" || v === "[" || v === "{") depth++;
          else if (v === ")" || v === "]" || v === "}") depth--;
          else if (v === "," && depth === 0) break;
        }
        continue;
      }
      if (isPunct(m, "{") || isPunct(m, "[")) {
        addPatternBindings(into, m);
        m = match.get(m) ?? m;
        continue;
      }
      if (tokens[m]?.type !== "ident") continue;
      if (isPunct(m + 1, ":")) continue; // property key, not a binding
      into.add(tokens[m].value);
    }
  };
  /** Parts of a class body run at definition: static fields / blocks, computed keys. */
  const classEagerRanges = (open: number, close: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let memberStart = true;
    for (let m = open + 1; m < close; m++) {
      const t = tokens[m];
      if (t.type === "punct" && (t.value === "(" || t.value === "[" || t.value === "{")) {
        const end = match.get(m) ?? m;
        // `[expr]` as a member name is computed at definition time.
        if (t.value === "[" && (memberStart || val(m - 1) === "static")) out.push([m, end]);
        m = end;
        memberStart = t.value === "{"; // after a method body, a new member starts
        continue;
      }
      if (t.type === "punct" && t.value === ";") {
        memberStart = true;
        continue;
      }
      if (t.type === "ident" && t.value === "static" && memberStart) {
        if (isPunct(m + 1, "{")) {
          // static { … } block
          const end = match.get(m + 1) ?? m + 1;
          out.push([m + 1, end]);
          m = end;
          continue;
        }
        // static name = initializer  →  the initializer up to `;` / next member
        let k = m + 1;
        while (k < close && !isPunct(k, "=") && !isPunct(k, ";") && !isPunct(k, "(") && !(k > m + 1 && tokens[k].nl)) k++;
        if (isPunct(k, "=")) {
          let e = k + 1;
          while (e < close && !isPunct(e, ";") && !(e > k + 1 && tokens[e].nl && tokens[e].depth === tokens[k].depth)) {
            const v = tokens[e].type === "punct" ? tokens[e].value : "";
            if (v === "(" || v === "[" || v === "{") e = match.get(e) ?? e;
            e++;
          }
          out.push([k, e]);
          m = e - 1;
        }
        memberStart = false;
        continue;
      }
      if (t.nl) memberStart = true;
      else memberStart = false;
    }
    return out;
  };
  /** Function bodies [open, close] (to skip nested function scopes). */
  const fnBodies: Array<[number, number]> = [];
  /**
   * Names declared in the block whose braces are [from, to]: let / const /
   * class / function at its own level; with `fnLevel`, also `var` anywhere
   * inside (hoisted to the function), but never inside nested functions.
   */
  const addDeclarations = (into: Set<string>, from: number, to: number, fnLevel: boolean) => {
    let depth = 0;
    for (let i = from + 1; i < to; i++) {
      const t = tokens[i];
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "(" || t.value === "[") {
          const nested = fnBodies.find(([a]) => a === i);
          if (nested) {
            i = nested[1];
            continue;
          }
          depth++;
        } else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
        continue;
      }
      const v = t.type === "ident" ? t.value : "";
      const here = depth === 0;
      if ((v === "const" || v === "let") && !here) continue;
      if (v === "var" && !fnLevel && !here) continue;
      if (v === "const" || v === "let" || v === "var") {
        // Every declarator binds: `const x = 0, value = 1`.
        for (const { at } of declarators(i)) {
          if (tokens[at].type === "ident") into.add(tokens[at].value);
          else addPatternBindings(into, at);
        }
      } else if (here && (v === "function" || v === "class") && tokens[i + 1]?.type === "ident") {
        into.add(tokens[i + 1].value);
      }
    }
  };
  /**
   * Every function's parameter list [paramsFrom, paramsTo] and the token
   * its scope ends at (`to`): parameters shadow outer bindings there.
   */
  const paramScopes: Array<{ paramsFrom: number; paramsTo: number; to: number }> = [];
  /** Identifiers a parameter list binds (defaults and computed keys are references). */
  const paramBindings = (paramsFrom: number, paramsTo: number) => {
    const locals = new Set<string>();
    /** Bracket depth inside the list: 1 directly inside its `(`. */
    let level = 0;
    for (let i = paramsFrom; i <= paramsTo; i++) {
      const t = tokens[i];
      // `x = value`: the default expression references, it doesn't bind.
      if (isPunct(i, "=")) {
        let depth = 0;
        for (i++; i <= paramsTo; i++) {
          const v = tokens[i].type === "punct" ? tokens[i].value : "";
          if (v === "(" || v === "[" || v === "{") depth++;
          else if (v === ")" || v === "]" || v === "}") {
            if (depth === 0) break;
            depth--;
          } else if (v === "," && depth === 0) break;
        }
        i--; // the `,` / closer that ends it is handled next
        continue;
      }
      // `{ [key]: v }`: a computed key is an expression (a reference).
      if (isPunct(i, "[") && (isPunct(i - 1, "{") || isPunct(i - 1, ","))) {
        const close = match.get(i);
        if (close !== undefined && isPunct(close + 1, ":")) {
          i = close;
          continue;
        }
      }
      if (isPunct(i, "(") || isPunct(i, "[") || isPunct(i, "{")) level++;
      else if (isPunct(i, ")") || isPunct(i, "]") || isPunct(i, "}")) level--;
      // `x: Array<number>`: a type annotation names types, it binds nothing.
      // (Inside a pattern, `{ key: value }`, the `:` is a level deeper.)
      if (isPunct(i, ":") && level === 1 && isPunct(paramsFrom, "(")) {
        let depth = 0;
        let angle = 0;
        for (i++; i <= paramsTo; i++) {
          const v = tokens[i].type === "punct" ? tokens[i].value : "";
          if (/^[<>]+$/.test(v)) angle += [...v].reduce((a, c) => a + (c === "<" ? 1 : -1), 0);
          else if (v === "(" || v === "[" || v === "{") depth++;
          else if (v === ")" || v === "]" || v === "}") {
            if (depth === 0) break;
            depth--;
          } else if ((v === "," || v === "=") && depth === 0 && angle <= 0) break;
        }
        i--; // the `,` / `=` / `)` that ends the type is handled next
        continue;
      }
      if (t?.type !== "ident") continue;
      if (isPunct(i - 1, ".") || (isPunct(i + 1, ":") && (isPunct(i - 1, "{") || isPunct(i - 1, ",")))) continue;
      locals.add(t.value);
    }
    return locals;
  };
  /** Locals: identifiers bound in the params and declared in the body. */
  const collectLocals = (paramsFrom: number, paramsTo: number, bodyFrom: number, bodyTo: number, own?: string) => {
    const locals = paramBindings(paramsFrom, paramsTo);
    if (own) locals.add(own);
    addDeclarations(locals, bodyFrom, bodyTo, true);
    return locals;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    // function [*] [name] ( … ) { … }
    if (t.type === "ident" && t.value === "function") {
      let p = k + 1;
      if (isPunct(p, "*")) p++;
      const own = tokens[p]?.type === "ident" ? tokens[p].value : undefined;
      if (own) p++;
      if (!isPunct(p, "(")) continue;
      const q = match.get(p);
      if (q === undefined || !isPunct(q + 1, "{")) continue;
      const end = match.get(q + 1) ?? tokens.length - 1;
      fnBodies.push([q + 1, end]);
      paramScopes.push({ paramsFrom: p, paramsTo: q, to: end });
      // `function () { … }()` in expression position runs now. (A
      // declaration followed by `(` on the next line is two statements.)
      let b = k - 1;
      if (val(b) === "async") b--;
      const statementStart = b < 0 || isPunct(b, ";") || isPunct(b, "{") || isPunct(b, "}") || val(b) === "export" || val(b) === "default";
      const invoked = !statementStart && isPunct(end + 1, "(");
      pending.push(() => {
        const locals = collectLocals(p, q, q + 1, end);
        const selfName = own && statementStart && tokens[k].depth === 0 && !locals.has(own) ? own : undefined;
        if (own) locals.add(own);
        return { from: p, to: end, retained: invoked ? false : retainedAt(k - 1), locals, selfName };
      });
      continue;
    }
    // ( … ) => …   /   x => …
    if (t.type === "punct" && t.value === "=>") {
      let pFrom = k - 1;
      let pTo = k - 1;
      if (isPunct(k - 1, ")")) pFrom = match.get(k - 1) ?? k - 1;
      else if (tokens[k - 1]?.type !== "ident") continue;
      let end: number;
      if (isPunct(k + 1, "{")) end = match.get(k + 1) ?? tokens.length - 1;
      else {
        // Expression body: up to a `,` / `;` at this level or the enclosing closer.
        end = k + 1;
        for (let i = k + 1; i < tokens.length; i++) {
          const v = tokens[i].type === "punct" ? tokens[i].value : "";
          if (v === "(" || v === "[" || v === "{") {
            i = match.get(i) ?? i;
            end = i;
            continue;
          }
          if (v === "," || v === ";" || v === ")" || v === "]" || v === "}") break;
          end = i;
        }
      }
      if (isPunct(k + 1, "{")) fnBodies.push([k + 1, end]);
      paramScopes.push({ paramsFrom: pFrom, paramsTo: pTo, to: end + 1 });
      pending.push(() => ({ from: pFrom, to: end, retained: retainedAt(pFrom - 1), locals: collectLocals(pFrom, pTo, k + 1, end) }));
      continue;
    }
    // Method with a computed or literal key: [expr]( … ) { … }, "name"( … ) { … }.
    if ((isPunct(k, "]") || t.type === "str" || t.type === "num") && isPunct(k + 1, "(")) {
      const q = match.get(k + 1);
      if (q === undefined || !isPunct(q + 1, "{")) continue;
      const keyStart = isPunct(k, "]") ? (match.get(k) ?? -1) : k;
      // `]` must close a `[` that starts a key, not an index (`a[0](…) {`
      // isn't valid anyway, but `[x](…)` after `{` / `,` / prefix is a key).
      const prev = val(keyStart - 1);
      const keyPos = prev === "{" || prev === "," || prev === ";" || prev === "}" || prev === "*" || METHOD_PREFIXES.has(prev);
      if (keyStart < 0 || !keyPos) continue;
      const end = match.get(q + 1) ?? tokens.length - 1;
      fnBodies.push([q + 1, end]);
      paramScopes.push({ paramsFrom: k + 1, paramsTo: q, to: end });
      pending.push(() => ({ from: k + 1, to: end, retained: true, locals: collectLocals(k + 1, q, q + 1, end) }));
      continue;
    }
    // Method: name ( … ) { … } in an object literal or class body.
    if (t.type === "ident" && isPunct(k + 1, "(")) {
      const q = match.get(k + 1);
      if (q === undefined || !isPunct(q + 1, "{")) continue;
      const prev = val(k - 1);
      const keyPos = prev === "{" || prev === "," || prev === ";" || prev === "}" || prev === "*" || METHOD_PREFIXES.has(prev);
      if (!keyPos || BLOCK_HEADS.has(t.value) || t.value === "function") continue;
      const end = match.get(q + 1) ?? tokens.length - 1;
      fnBodies.push([q + 1, end]);
      paramScopes.push({ paramsFrom: k + 1, paramsTo: q, to: end });
      pending.push(() => ({ from: k + 1, to: end, retained: true, locals: collectLocals(k + 1, q, q + 1, end) }));
    }
  }
  // Locals need every function body known first (nested ones are skipped).
  for (const make of pending) scopes.push(make());
  // Statement blocks are scopes too: a `let` / `const` inside `{ … }` only
  // shadows within it. (Object literals declare nothing, so they're inert.)
  tokens.forEach((t, i) => {
    if (t.type !== "punct" || t.value !== "{" || fnBodies.some(([a]) => a === i)) return;
    const close = match.get(i);
    if (close === undefined) return;
    // Class bodies: field initializers run at `new`, i.e. later — late-bound
    // like methods. (A `static` initializer runs at definition; rare enough
    // to treat the same.)
    if (isClassBody(tokens, i)) {
      scopes.push({ from: i, to: close, retained: true, locals: new Set(), eager: classEagerRanges(i, close) });
      return;
    }
    const locals = new Set<string>();
    addDeclarations(locals, i, close, false);
    if (locals.size) scopes.push({ from: i, to: close, retained: false, locals, block: true });
  });
  return scopes;
}

/** The `${ … }` expressions of a template literal's source, with offsets into it. */
export function templateExpressions(tpl: string): Array<{ offset: number; code: string }> {
  const out: Array<{ offset: number; code: string }> = [];
  for (let i = 1; i < tpl.length; i++) {
    if (tpl[i] === "\\") {
      i++;
      continue;
    }
    if (tpl[i] !== "$" || tpl[i + 1] !== "{") continue;
    const from = i + 2;
    const close = tokenize(tpl.slice(from)).find((x) => x.type === "punct" && x.value === "}" && x.depth === 0);
    if (!close) break;
    out.push({ offset: from, code: tpl.slice(from, from + close.start) });
    i = from + close.start;
  }
  return out;
}
