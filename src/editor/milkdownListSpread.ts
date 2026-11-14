/**
 * Lists in the WYSIWYG editor (found by the plan 9.7 e2e).
 *
 * @milkdown/preset-commonmark 7.20 declares the list nodes' `spread`
 * attribute with `validate: "boolean"`, but its own Markdown parser stores
 * it as a string (`${node.spread}`). prosemirror-model ≥ 1.25 enforces
 * `validate`, so opening any note with a list threw
 * "Expected value of type boolean for attribute spread" and the WYSIWYG
 * editor came up empty. The rest of the preset reads both forms
 * (`=== "true"` in one place, truthiness in another), so dropping the
 * check restores the behaviour the preset was written for. Remove once
 * Milkdown parses `spread` as a boolean.
 */
import { bulletListSchema, orderedListSchema } from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask } from "@milkdown/preset-gfm";

type Spec = { attrs?: Record<string, { default?: unknown; validate?: unknown }> };
type Factory = (ctx: never) => Spec;
type WithExtend = { extendSchema: (h: (prev: Factory) => Factory) => unknown };

function looseSpread<T extends WithExtend>(schema: T) {
  return schema.extendSchema((prev) => (ctx) => {
    const spec = prev(ctx);
    const spread = spec.attrs?.spread;
    return spread ? { ...spec, attrs: { ...spec.attrs, spread: { default: spread.default } } } : spec;
  });
}

/** Use after `commonmark` and `gfm`: the same node ids replace theirs. */
export const listSpreadFix = [
  looseSpread(bulletListSchema as unknown as WithExtend),
  looseSpread(orderedListSchema as unknown as WithExtend),
  looseSpread(extendListItemSchemaForTask as unknown as WithExtend),
].flat() as never[];
