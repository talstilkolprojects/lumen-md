/**
 * Words in a Markdown chapter, counted the way a Hebrew writer counts them
 * (plan W5.8).
 *
 * Only prose counts: frontmatter, code, comments (`%% … %%`, `<!-- -->`),
 * link targets, embeds and Markdown punctuation do not. A Hebrew word with
 * its prefixes is one word, including a prefix joined by a hyphen or maqaf
 * to a number or a Latin word (`ה-CNN`, `ב־1948`, `וכשהבית`); so are
 * abbreviations with geresh / gershayim (`צה״ל`, `ת"א`, `מס׳`) and joined
 * compounds (`בית־ספר`). Tools that split on every non-letter count `ה-CNN`
 * as two words and `צה״ל` as two; Word and Scrivener differ on these, which
 * is why the rule is written down here.
 */

const LETTER = "\\p{L}\\p{N}\\p{M}";
/** A run of letters / digits, joined by word-internal marks. */
const WORD = new RegExp(`[${LETTER}]+(?:(?:['\u2019\u05F3\u05F4"\\-\u05BE\u2010\u2011][${LETTER}]+)|(?:[.,:]\\p{N}+))*`, "gu");

/** The prose of a Markdown note: what a reader reads. */
export function proseOf(markdown: string): string {
  let s = markdown.replace(/^\uFEFF/, "");
  // Frontmatter.
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
  // Fenced code and math blocks.
  s = s.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[`~]*[ \t]*$|(?![\s\S]))/gm, "");
  s = s.replace(/^\$\$[\s\S]*?^\$\$[ \t]*$/gm, "");
  // Comments.
  s = s.replace(/%%[\s\S]*?(?:%%|$)/g, " ").replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  // Inline code and math.
  s = s.replace(/`+[^`\n]*`+/g, " ").replace(/\$[^$\n]+\$/g, " ");
  // Embeds and images: not words.
  s = s.replace(/!\[\[[^\]\n]*\]\]/g, " ").replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ");
  // Links: their text, not their target.
  s = s.replace(/\[\[([^\]|\n]*)\|([^\]\n]*)\]\]/g, "$2").replace(/\[\[([^\]\n]*)\]\]/g, (_, t: string) => t.replace(/#\^?/g, " "));
  s = s.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1").replace(/<https?:[^>\s]*>/g, " ").replace(/\bhttps?:\/\/\S+/g, " ");
  // Footnote markers, block ids, HTML tags.
  s = s.replace(/\[\^[^\]\n]*\]:?/g, " ").replace(/(^|\s)\^[A-Za-z0-9-]+(?=\s|$)/g, " ").replace(/<\/?[A-Za-z][^>\n]*>/g, " ");
  // Callout headers (`> [!note] Title` keeps its title).
  s = s.replace(/\[![\w-]+\][+-]?/g, " ");
  return s;
}

/** Words in a Markdown text. */
export function countWords(markdown: string): number {
  return proseOf(markdown).match(WORD)?.length ?? 0;
}
