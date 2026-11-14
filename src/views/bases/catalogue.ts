/**
 * The Bases function catalogue (split out of evaluate.ts, plan W4.11; it
 * re-exports every name): the global functions and methods of the Bases
 * reference, the ones not run here, and parseBases() over those tables.
 */
import { type FormulaLimits } from "../formula/ast";
import { parseBasesExpr, type BasesParse } from "./expr";

/* ─── The function catalogue ─────────────────────────────────────────── */

export const BASES_GLOBALS = ["escapeHTML", "date", "duration", "file", "html", "if", "image", "icon", "link", "list", "max", "min", "now", "number", "today", "random"] as const;

/** Every function in the Bases reference, as `Type.name` (global ones as `global.name`). */
export const BASES_DOCUMENTED: readonly string[] = [
  ...BASES_GLOBALS.map((n) => `global.${n}`),
  "any.isTruthy", "any.isType", "any.toString",
  "date.date", "date.format", "date.time", "date.relative", "date.isEmpty",
  "string.contains", "string.containsAll", "string.containsAny", "string.endsWith", "string.isEmpty", "string.lower", "string.replace", "string.repeat", "string.reverse", "string.slice", "string.split", "string.startsWith", "string.title", "string.trim",
  "number.abs", "number.ceil", "number.floor", "number.isEmpty", "number.round", "number.toFixed",
  "list.contains", "list.containsAll", "list.containsAny", "list.filter", "list.flat", "list.isEmpty", "list.join", "list.map", "list.reduce", "list.reverse", "list.slice", "list.sort", "list.unique",
  "link.asFile", "link.linksTo",
  "file.asLink", "file.hasLink", "file.hasProperty", "file.hasTag", "file.inFolder",
  "object.isEmpty", "object.keys", "object.values",
  "regexp.matches",
];

/**
 * Documented, not run here: `icon()` needs Obsidian's icon set (Lucide, ~1,500
 * icons — far over the lazy-chunk budget); `html()` is shown as plain text,
 * never as markup, so it is counted as not supported.
 */
export const BASES_UNSUPPORTED: ReadonlySet<string> = new Set(["global.icon", "global.html"]);

/**
 * Global functions of the first Bases releases (1.9), no longer in the
 * reference but still in real files (plan W4.30: kepano's own vault has
 * `not(empty(note.last))`): `not(x)` is `!x`, `empty(x)` is `x.isEmpty()`.
 */
export const BASES_LEGACY_GLOBALS = ["not", "empty"] as const;

const GLOBAL_SET: ReadonlySet<string> = new Set<string>([...BASES_GLOBALS.filter((n) => !BASES_UNSUPPORTED.has(`global.${n}`)), "html", ...BASES_LEGACY_GLOBALS]);
const METHOD_NAMES: ReadonlySet<string> = new Set(
  BASES_DOCUMENTED.filter((n) => !n.startsWith("global.")).map((n) => n.slice(n.indexOf(".") + 1)).concat(["upper", "length", "toLowerCase", "toUpperCase", "includes", "matches"]),
);
const UNSUPPORTED_NAMES: ReadonlySet<string> = new Set([...BASES_UNSUPPORTED].map((n) => n.slice(n.indexOf(".") + 1)).filter((n) => n !== "html"));

/** Parse a Bases expression with the Bases function table. */
export function parseBases(src: string, limits?: Partial<FormulaLimits>): BasesParse {
  return parseBasesExpr(src, { limits, globals: GLOBAL_SET, methods: METHOD_NAMES, unsupported: UNSUPPORTED_NAMES });
}
