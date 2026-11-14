/**
 * The mobile toolbar's row as the store keeps it (plan W1.25): the action
 * ids, the default row and the clean-up of a stored row. Small on purpose:
 * the store loads it at startup, while the actions themselves
 * (./toolbarActions) load with the editor and the toolbar.
 */

/** Every toolbar action, in the order the customise sheet lists them. */
export const TOOLBAR_ACTION_IDS = [
  "indent",
  "outdent",
  "task",
  "link",
  "image",
  "heading",
  "bold",
  "italic",
  "bullet",
  "numbered",
  "wikilink",
  "tag",
  "code",
  "quote",
  "undo",
  "redo",
  "hideKeyboard",
] as const;

export type ToolbarActionId = (typeof TOOLBAR_ACTION_IDS)[number];

const KNOWN = new Set<string>(TOOLBAR_ACTION_IDS);

/**
 * The default row: the four the plan names first (indent/outdent, task,
 * link, image), then what the tap-count table (docs/mobile-taps.json) shows
 * people reach for most. Hide-keyboard is last so a thumb finds it at the
 * row's end in both directions.
 */
export const DEFAULT_TOOLBAR: readonly ToolbarActionId[] = [
  "indent",
  "outdent",
  "task",
  "link",
  "image",
  "heading",
  "bold",
  "bullet",
  "wikilink",
  "undo",
  "hideKeyboard",
];

/** A stored row, cleaned: known ids only, no repeats; an empty or broken row falls back to the default. */
export function sanitizeToolbar(ids: unknown): ToolbarActionId[] {
  if (!Array.isArray(ids)) return [...DEFAULT_TOOLBAR];
  const seen = new Set<string>();
  const out: ToolbarActionId[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id) || !KNOWN.has(id)) continue;
    seen.add(id);
    out.push(id as ToolbarActionId);
  }
  return out.length ? out : [...DEFAULT_TOOLBAR];
}
