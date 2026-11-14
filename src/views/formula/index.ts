/**
 * Database formulas (plan 4.11) — computed columns for the database view.
 *
 *   ```database
 *   formulas:
 *     total: price * qty
 *     late: if(due < today() and status != "done", "late", "")
 *     שנה: year(תאריך)
 *   ```
 *
 * `parseFormula` → a tree over a closed set of node types (ast.ts);
 * `evaluate` interprets it over one row with a deterministic step budget;
 * only the functions in functions.ts can be called. Syntax and function
 * list: docs/src/content/docs/workspace/database-formulas.md.
 */

export { FormulaError, DEFAULT_LIMITS, type FormulaErrorCode, type FormulaLimits, type FormulaNode, type FormulaValue } from "./ast";
export { parseFormula, parseFormulaOrThrow, type FormulaParse, type ParseOptions } from "./parse";
export { evaluate, evaluateFormula, evaluateOrThrow, type EvalOptions, type FormulaResult, type FormulaRow } from "./evaluate";
export { BUILTIN_FUNCTIONS, functionNames, lookupFunction, type CallContext, type FormulaFunction, type FunctionTable } from "./functions";
export { toText as formulaText } from "./values";
