// Text format — an example Lumen plugin (plan W3.10): a port of part of
// "obsidian-text-format" by Benature Wong (MIT), from
// https://github.com/Benature/obsidian-text-format at commit
// 4d0c45396d9d587b3240b693b971093bddae3c10, src/format.ts. The functions
// below keep the upstream logic; the Obsidian editor calls are replaced
// with the `lumen` API. See LICENSE in this folder.
//
// Commands work on the selection: lower case, upper case, capitalize
// words, capitalize sentences, title case, slug, snake_case, camelCase,
// and removing doubled spaces. Hebrew and Arabic have no case, so only
// the Latin, Greek and Cyrillic parts of a mixed line change.

const LC = "[\\p{L}\\p{N}_]"; // Unicode letters, numbers, and underscore
const TURKISH_SPECIFIC_LETTERS = /[ıİşŞğĞçÇöÖüÜ]/;

function toLowerCaseWithLocale(text) {
  return TURKISH_SPECIFIC_LETTERS.test(text) ? text.toLocaleLowerCase("tr") : text.toLowerCase();
}

function capitalizeWord(str) {
  const rx = new RegExp(LC + "\\S*", "gu");
  return str.replace(rx, (t) => t.charAt(0).toUpperCase() + t.slice(1));
}

function capitalizeSentence(s) {
  const lcp = "(" + LC + "+)";
  const rx = new RegExp(String.raw`(?:^|[\n"“]|[.!?~#]\s+|\s*- \s*|\s*(?:[-*+]|\d+[.)])\s+\[[ xX]?\]\s+)` + lcp, "gu");
  return s.replace(rx, (t0, t) => (/^(ve|t|m|d|ll|s|re)$/.test(t) ? t0 : t0.replace(t, t.charAt(0).toUpperCase() + t.slice(1))));
}

// reference (upstream): https://github.com/gouch/to-title-case
function toTitleCase(text) {
  const smallWords = /^(a|an|and|as|at|but|by|en|for|if|in|nor|of|on|or|per|the|to|v.?|vs.?|via)$/i;
  const alphanumericPattern = /([\p{L}\p{N}])/u;
  const wordSeparators = /([\s:–—()-])/;
  return text
    .split(wordSeparators)
    .map((current, index, array) => {
      if (
        current.search(smallWords) > -1 &&
        index !== 0 &&
        index !== array.length - 1 &&
        array[index - 3] !== ":" &&
        array[index + 1] !== ":" &&
        (array[index + 1] !== "-" || (array[index - 1] === "-" && array[index + 1] === "-"))
      ) {
        return current.toLowerCase();
      }
      if (current.slice(1).search(/[\p{Lu}]|\../u) > -1) return current;
      if (array[index + 1] === ":" && array[index + 2] !== "") return current;
      return current.replace(alphanumericPattern, (match) => match.toUpperCase());
    })
    .join("");
}

// Upstream keeps Latin, Cyrillic and Swedish letters; this port keeps every
// letter (\p{L}), so Hebrew and Arabic headings get slugs too.
function slugify(text, maxLength = 76) {
  text = text.toLowerCase();
  text = text.replace(/[^\p{L}\p{N}\s]|_/gu, "").replace(/\s+/g, " ").trim();
  text = text.replace(/\s+/g, "-");
  text = text.normalize("NFD").replace(/[\u0300-\u036F]/g, "");
  text = text.replace(/-{2,}/g, "-");
  if (/^\d+$/.test(text)) text = `item-${text}`;
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    if (text.endsWith("-")) text = text.slice(0, text.lastIndexOf("-"));
  }
  return text.replace(/^-+|-+$/g, "");
}

function snakify(text) {
  return text.toLowerCase().replace(/\s+/g, "_");
}

function camelCase(text, lowerFirst = false) {
  text = toTitleCase(toLowerCaseWithLocale(text)).replace(/\s+/g, "");
  return lowerFirst ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

// Upstream "remove redundant spaces": doubled spaces inside a line (not the indent) and trailing spaces.
function removeRedundantSpaces(s) {
  return s.replace(/(\S) {2,}(?=\S)/g, "$1 ").replace(/ +$/gm, "");
}

const COMMANDS = [
  ["lowercase", "Lower case", toLowerCaseWithLocale],
  ["uppercase", "Upper case", (s) => s.toUpperCase()],
  ["capitalize-words", "Capitalize words", capitalizeWord],
  ["capitalize-sentences", "Capitalize sentences", capitalizeSentence],
  ["title-case", "Title case", toTitleCase],
  ["slugify", "Slug (kebab-case)", (s) => slugify(s)],
  ["snake-case", "snake_case", snakify],
  ["camel-case", "camelCase", (s) => camelCase(s, true)],
  ["pascal-case", "PascalCase", (s) => camelCase(s)],
  ["spaces", "Remove redundant spaces", removeRedundantSpaces],
];

for (const [id, label, fn] of COMMANDS) {
  await lumen.commands.register({ id, label: `Text format: ${label}`, hint: "On the selected text" }, async () => {
    const sel = await lumen.document.getSelection();
    if (!sel || sel.from === sel.to) return;
    const out = fn(sel.text);
    if (out !== sel.text) await lumen.document.replaceSelection(out);
  });
}
