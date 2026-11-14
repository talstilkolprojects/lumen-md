/**
 * Hebrew search for the docs (plan W1.28). On a Hebrew page, adds the bare
 * forms of its prefixed words (./hebrew-forms.mjs) as a visually hidden,
 * low-weight block that only the search index reads: "פתקים" then finds a
 * page that says "והפתקים". Screen readers skip it (aria-hidden); English
 * pages are left alone.
 */
import { hebrewBaseForms } from "./hebrew-forms.mjs";

function textOf(node) {
  if (node.type === "text") return node.value;
  if (node.type === "element" && ["pre", "code", "script", "style"].includes(node.tagName)) return "";
  return (node.children ?? []).map(textOf).join(" ");
}

export function isHebrewPage(path) {
  return /[\\/]content[\\/]docs[\\/]he[\\/]/.test(String(path ?? ""));
}

const block = (forms, weight) => ({
  type: "element",
  tagName: "div",
  properties: { className: ["sr-only"], ariaHidden: "true", dataPagefindWeight: String(weight), dataHebrewSearchForms: "" },
  children: [{ type: "text", value: forms.join(" ") }],
});

export default function rehypeHebrewSearch() {
  return (tree, file) => {
    if (!isHebrewPage(file.path ?? file.history?.[0])) return;
    // The page title (Starlight's <h1>, from the frontmatter) weighs as a title.
    const title = String(file.data?.astro?.frontmatter?.title ?? "");
    const titleForms = hebrewBaseForms(title);
    const bodyForms = hebrewBaseForms(`${title} ${textOf(tree)}`).filter((f) => !titleForms.includes(f));
    if (titleForms.length) tree.children.push(block(titleForms, 5));
    if (bodyForms.length) tree.children.push(block(bodyForms, 0.5));
  };
}
