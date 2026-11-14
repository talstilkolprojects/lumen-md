/**
 * Wiki links survive the WYSIWYG editor.
 *
 * Milkdown has no wiki-link node: `[[Note]]` is text, and its serializer
 * escapes every `[` in text — a note edited in WYSIWYG came back as
 * `\[\[Note]]`, which the workspace index, backlinks, link rewriting and
 * Obsidian don't read as a link. (The preview still did: it looks at the
 * unescaped text.) A link inserted by `[[` completion (4.5) had the same
 * fate. This keeps `[[…]]` as written.
 *
 * Only a complete `[[…]]` on one line is kept, and not when `(` or `[`
 * follows it — `[[x]](y)` unescaped would turn into a Markdown link.
 *
 * A `\[\[x]]` the author escaped on purpose must stay escaped, but the
 * parser hands it over as the same text as a real `[[x]]`. So before the
 * document goes into the editor, `protectEscapedWikiLinks` puts a word
 * joiner (U+2060, invisible) between its brackets; the serializer writes
 * that back as `\[\[` and drops the joiner.
 *
 * Milkdown passes its own `text` handler in the stringify options, which
 * win over remark extensions — so this wraps that handler in the options.
 */

import type { Handle, Options } from "mdast-util-to-markdown";
import { defaultHandlers } from "mdast-util-to-markdown";
import { stripCode } from "../lint/vaultDoctor";

const ESCAPED_WIKI = /\\\[\\?\[(?=[^[\]\n]*\]\](?![([]))/g;

/** Between the brackets of an escaped `\[\[`, while the document is in the editor. */
const JOINER = "\u2060";

/**
 * `\[\[Note]]` → `[[Note]]` in serialized text; the protected `[` U+2060 `[`
 * → `\[\[`, escaped or not (Milkdown writes a text ending in a space as is).
 */
export function unescapeWikiLinks(md: string): string {
  const out = md.replace(ESCAPED_WIKI, "[[");
  return out.includes(JOINER) ? out.replace(/\\?\[\u2060\\?\[/g, "\\[\\[").replace(/\\?\[\u2060/g, "\\[") : out;
}

/**
 * Mark each escaped `\[\[` / `\[[` outside code (its first backslash not
 * itself escaped) with a joiner after the first bracket, so it can't pass
 * for a wiki link on the way out.
 */
export function protectEscapedWikiLinks(md: string): string {
  if (!md.includes("\\[")) return md;
  // Code blanked to spaces: offsets stay those of `md`.
  const scan = stripCode(md);
  let out = "";
  let last = 0;
  for (const m of scan.matchAll(/(?<!\\)((?:\\\\)*)\\\[(?=\\?\[)/g)) {
    const at = (m.index ?? 0) + m[1].length + 2;
    out += md.slice(last, at) + JOINER;
    last = at;
  }
  return out + md.slice(last);
}

/** For `ctx.update(remarkStringifyOptionsCtx, keepWikiLinks)`: the text handler, minus the wiki-link escapes. */
export function keepWikiLinks<T extends { handlers?: Options["handlers"] }>(options: T): T {
  const text = options.handlers?.text ?? (defaultHandlers.text as Handle);
  const wrapped: Handle = (node, parent, state, info) => unescapeWikiLinks(text(node, parent, state, info));
  return { ...options, handlers: { ...options.handlers, text: wrapped } };
}
