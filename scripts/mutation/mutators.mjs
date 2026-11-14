/**
 * Plan 0.15 — the mutators: small, plausible bugs, made on the TypeScript
 * syntax tree (so comments, strings, types and imports are never touched).
 * Each mutant is { start, end, text, kind } over the source.
 *
 *   operators   + ↔ -, * ↔ /, % → *, < ↔ <=, > ↔ >=, === ↔ !==, == ↔ !=,
 *               && ↔ ||, ?? → ||, & ↔ |, ^ → &, << ↔ >>, >>> → >>
 *   booleans    true ↔ false
 *   constants   an integer literal n → n + 1 (0 → 1, 1 → 0)
 *   negation    a prefix ! removed
 *   conditions  if (c) → if (!(c))
 */
const SWAP = {
  "+": "-", "-": "+", "*": "/", "/": "*", "%": "*",
  "<": "<=", "<=": "<", ">": ">=", ">=": ">",
  "===": "!==", "!==": "===", "==": "!=", "!=": "==",
  "&&": "||", "||": "&&", "??": "||",
  "&": "|", "|": "&", "^": "&",
  "<<": ">>", ">>": "<<", ">>>": ">>",
  "+=": "-=", "-=": "+=", "^=": "&=", "|=": "&=", "&=": "|=",
};

export function mutantsOf(ts, source) {
  // The syntax tree, so only expressions are mutated: never a type (`A | B`
  // is a union, not an or), an import, or a generic's angle brackets.
  const sf = ts.createSourceFile("m.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const add = (start, end, text, kind) => out.push({ start, end, text, kind });
  const visit = (node) => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken;
      const text = op.getText(sf);
      if (SWAP[text] !== undefined) add(op.getStart(sf), op.getEnd(), SWAP[text], `${text} → ${SWAP[text]}`);
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      add(node.getStart(sf), node.operand.getStart(sf), "", "! removed");
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const t = node.getText(sf);
      add(node.getStart(sf), node.getEnd(), t === "true" ? "false" : "true", `${t} → ${t === "true" ? "false" : "true"}`);
    } else if (ts.isNumericLiteral(node) && /^(0x[0-9a-f]+|\d+)$/i.test(node.getText(sf)) && !ts.isEnumMember(node.parent)) {
      const t = node.getText(sf);
      const n = Number(t);
      if (Number.isSafeInteger(n)) {
        const m = n === 1 ? 0 : n + 1;
        const text = /^0x/i.test(t) ? "0x" + m.toString(16) : String(m);
        add(node.getStart(sf), node.getEnd(), text, `${t} → ${text}`);
      }
    } else if (ts.isIfStatement(node)) {
      const c = node.expression;
      add(c.getStart(sf), c.getEnd(), `!(${c.getText(sf)})`, "if (c) → if (!(c))");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((x, y) => x.start - y.start);
}

export function apply(source, m) {
  return source.slice(0, m.start) + m.text + source.slice(m.end);
}

/** A mutant that does not even parse is not a test of the tests: it is left out. */
export function parses(ts, path, text) {
  const r = ts.transpileModule(text, { fileName: path, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return !(r.diagnostics ?? []).some((d) => d.category === ts.DiagnosticCategory.Error);
}

/** At most `max` mutants, spread evenly over the file (deterministic). */
export function sample(mutants, max) {
  if (mutants.length <= max) return mutants;
  const step = mutants.length / max;
  return Array.from({ length: max }, (_, i) => mutants[Math.floor(i * step)]);
}
