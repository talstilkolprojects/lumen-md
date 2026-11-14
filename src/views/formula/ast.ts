/**
 * Database formulas (plan 4.11) — the closed set of AST node types, the
 * typed error every failure becomes, and the per-evaluation limits.
 *
 * A formula is parsed once into this tree and then interpreted by
 * `evaluate.ts`, which switches over exactly these node kinds and calls
 * only the functions in `functions.ts`. Nothing is ever compiled to
 * JavaScript, and no host object is reachable from a formula.
 */

export type FormulaValue = number | string | boolean | null | Date | FormulaValue[];

export type BinaryOp = "or" | "and" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "&" | "*" | "/" | "%" | "^";
export type UnaryOp = "-" | "+" | "not";

/** Every node a formula can contain. `at` is the source offset, for error messages. */
export type FormulaNode =
  | { kind: "num"; value: number; at: number }
  | { kind: "str"; value: string; at: number }
  | { kind: "bool"; value: boolean; at: number }
  | { kind: "null"; at: number }
  | { kind: "field"; path: string[]; at: number }
  | { kind: "list"; items: FormulaNode[]; at: number }
  | { kind: "unary"; op: UnaryOp; arg: FormulaNode; at: number }
  | { kind: "binary"; op: BinaryOp; left: FormulaNode; right: FormulaNode; at: number }
  | { kind: "call"; name: string; args: FormulaNode[]; at: number };

export type FormulaErrorCode =
  /** The text is not a formula (bad token, missing parenthesis…). */
  | "syntax"
  /** A function name that is not in the table. */
  | "unknown-function"
  /** A function called with too few or too many arguments. */
  | "arity"
  /** A value of the wrong type (`"a" * 2`, `year("soon")`). */
  | "type"
  /** Division by zero, or a result that is not a finite number. */
  | "math"
  /** A limit was hit: source length, nesting, node count, steps, text or list size. */
  | "limit";

/** The only error formulas throw or return. `at` is the source offset, -1 when unknown. */
export class FormulaError extends Error {
  constructor(
    readonly code: FormulaErrorCode,
    message: string,
    readonly at: number = -1,
  ) {
    super(message);
    this.name = "FormulaError";
  }
}

/**
 * Deterministic bounds (never wall-clock): the same formula on the same row
 * always succeeds or always fails, on any machine.
 */
export interface FormulaLimits {
  /** Characters in the source. */
  maxLength: number;
  /** Depth of the tree (parentheses, nested calls, chained operators). */
  maxDepth: number;
  /** Nodes in the tree. */
  maxNodes: number;
  /** Interpreter steps for one evaluation (one per node visited, plus per list item a function walks). */
  maxSteps: number;
  /** Characters in any text value produced. */
  maxText: number;
  /** Items in any list value produced. */
  maxList: number;
}

export const DEFAULT_LIMITS: FormulaLimits = {
  maxLength: 2000,
  maxDepth: 64,
  maxNodes: 1000,
  maxSteps: 20000,
  maxText: 20000,
  maxList: 2000,
};

/** A step budget shared by the interpreter and the functions it calls. */
export class Budget {
  steps = 0;
  constructor(readonly limits: FormulaLimits) {}
  tick(n = 1, at = -1): void {
    this.steps += n;
    if (this.steps > this.limits.maxSteps) throw new FormulaError("limit", `the formula takes more than ${this.limits.maxSteps} steps`, at);
  }
}
