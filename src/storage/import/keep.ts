/**
 * Google Keep, from Google Takeout (takeout.google.com → Keep): one `.json`
 * per note (an `.html` copy next to it), attachments beside them. Text and
 * checklists become Markdown; labels, colour, pin and dates become
 * properties; archived notes go to `Archive/`, trashed ones are left out.
 *
 * Plan W11.P1: the fidelity rules below are
 * ported from obsidian-importer 3.1.15 (src/formats/keep/convert.ts, MIT,
 * © 2023 Obsidian; see
 * THIRD_PARTY_NOTICES.md): Keep's rich text (`textContentHtml`, a checklist
 * item's `textHtml`) is used when it holds formatting the plain text lacks,
 * with Keep's inline CSS read as bold / italic / struck / underline; a
 * title with line breaks keeps its first line and lists every line as an
 * alias; annotations become a list with their descriptions; a note never
 * edited takes its creation time as its edit time; Keep tasks are marked.
 */
import { claimPath, dirOf, mdEmbed, safeName, stemOf } from "./names";
import { htmlToNote } from "./html";
import { parseInertDocument } from "../../lib/trustedTypes";
import { isoDate, tagValue, withFrontmatter } from "./frontmatter";
import { emptyVault, type ConvertedVault } from "./types";

interface KeepNote {
  title?: string;
  textContent?: string;
  textContentHtml?: string;
  listContent?: { text?: string; textHtml?: string; isChecked?: boolean }[];
  labels?: { name?: string }[];
  attachments?: { filePath?: string; mimetype?: string }[];
  annotations?: { url?: string; title?: string; description?: string; source?: string }[];
  tasks?: unknown[];
  createdTimestampUsec?: number;
  userEditedTimestampUsec?: number;
  isTrashed?: boolean;
  isArchived?: boolean;
  isPinned?: boolean;
  color?: string;
}

const isKeepNote = (v: unknown): v is KeepNote =>
  !!v && typeof v === "object" && ("textContent" in v || "listContent" in v) && ("userEditedTimestampUsec" in v || "createdTimestampUsec" in v);

/* ─── Rich text (ported from obsidian-importer, see the header) ─────────── */

const BOLD = "b, strong, h1, h2, h3, h4, h5, h6";
const ITALIC = "i, em";
const STRUCK = "s, strike, del";
const isBold = (st: CSSStyleDeclaration) => st.fontWeight === "bold" || Number(st.fontWeight) >= 600;
const isItalic = (st: CSSStyleDeclaration) => st.fontStyle === "italic" || st.fontStyle === "oblique";
const isStruck = (st: CSSStyleDeclaration) => (st.textDecoration || "").includes("line-through");
const isUnderline = (st: CSSStyleDeclaration) => (st.textDecoration || "").includes("underline");

function wrap(el: Element, tag: string): void {
  if (!el.childNodes.length) return;
  const w = el.ownerDocument.createElement(tag);
  w.append(...Array.from(el.childNodes));
  el.append(w);
}

/** Does the HTML hold formatting the plain text can't (a named link counts; a bare URL Keep wrapped does not)? */
function hasFormatting(root: ParentNode): boolean {
  if (root.querySelector("h1, h2, h3, h4, h5, h6, strong, b, em, i, u, s, strike, del, mark, blockquote, ul, ol, pre, code, table, hr, img[src]")) return true;
  if (Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).some((a) => a.textContent !== a.getAttribute("href"))) return true;
  return Array.from(root.querySelectorAll<HTMLElement>("[style]")).some(({ style }) => isBold(style) || isItalic(style) || isStruck(style) || isUnderline(style));
}

/** Keep's inline CSS as semantic elements, without doubling what an ancestor already says. */
function normalizeFormatting(root: Element): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    const st = el.style;
    if (isBold(st) && !el.closest(BOLD)) wrap(el, "strong");
    if (isItalic(st) && !el.closest(ITALIC)) wrap(el, "em");
    if (isStruck(st) && !el.closest(STRUCK)) wrap(el, "del");
    if (isUnderline(st) && !el.closest("u")) wrap(el, "u");
    el.removeAttribute("style");
  }
}

/** A Keep rich-text fragment → Markdown, or the plain text when the HTML adds nothing. */
function richText(html: string | undefined, plain: string | undefined, inList = false): string {
  if (!html?.trim()) return plain ?? "";
  const doc = parseInertDocument(`<html><body>${html}</body></html>`, "text/html");
  if (plain?.trim() && !hasFormatting(doc.body)) return plain;
  if (inList) {
    // A heading means nothing inside a checklist item: it would read as literal "#" text.
    for (const h of Array.from(doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
      const p = doc.createElement("p");
      p.append(...Array.from(h.childNodes));
      h.replaceWith(p);
    }
  }
  normalizeFormatting(doc.body);
  // Markdown has no underline: <u> is kept as the small HTML subset the renderer shows.
  for (const u of Array.from(doc.body.querySelectorAll("u"))) if (!u.parentElement?.closest("u")) u.replaceWith(doc.createTextNode("\uE000KU\uE001"), ...Array.from(u.childNodes), doc.createTextNode("\uE000KE\uE001"));
  const md = htmlToNote(doc.body.innerHTML).trim().split("\uE000KU\uE001").join("<u>").split("\uE000KE\uE001").join("</u>");
  return md || plain || "";
}

/** A checklist item on one line: Keep's line breaks inside an item become <br>. */
const oneLine = (s: string) => s.replace(/\r?\n(?:[ \t]*\r?\n)*/g, "<br>");

const squash = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>])/g, "\\$1");
const angleUrl = (u: string) => `<${u.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;

/** Keep's annotations (saved web links) as a list, each with its description when it says more than the title. */
function annotationsList(list: KeepNote["annotations"]): string {
  const items: string[] = [];
  for (const a of list ?? []) {
    const title = squash(a.title);
    const url = squash(a.url);
    const desc = squash(a.description);
    const primary = title && url ? `[${escapeMd(title)}](${angleUrl(url)})` : url ? angleUrl(url) : escapeMd(title || desc);
    if (!primary) continue;
    items.push(`- ${primary}`);
    if (desc && desc !== title && escapeMd(desc) !== primary) items.push(`  ${escapeMd(desc)}`);
  }
  return items.length ? `## Annotations\n\n${items.join("\n")}` : "";
}

/** Takeout names an attachment `x.jpeg` in the JSON and `x.jpg` on disk (and the other way round). */
function findAttachment(files: Map<string, Uint8Array>, dir: string, name: string): string | undefined {
  const exact = dir ? `${dir}/${name}` : name;
  if (files.has(exact)) return exact;
  const stem = name.replace(/\.[^.]+$/, "");
  for (const p of files.keys()) if (dirOf(p) === dir && stemOf(p) === stem && !/\.(json|html)$/i.test(p)) return p;
  return undefined;
}

export function convertKeep(files: Map<string, Uint8Array>): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const used = new Set<string>();
  const trashed = new Set<string>();
  const dec = new TextDecoder();
  const usec = (n: number | undefined) => (typeof n === "number" && n > 0 ? isoDate(Math.round(n / 1000)) : undefined);
  const notes = [...files.keys()].filter((p) => /\.json$/i.test(p));
  for (const path of notes) {
    let json: unknown;
    try {
      json = JSON.parse(dec.decode(files.get(path)!));
    } catch {
      vault.skipped.push({ path, reason: "unreadable" });
      continue;
    }
    if (!isKeepNote(json)) {
      vault.skipped.push({ path, reason: "unsupported" });
      continue;
    }
    if (json.isTrashed) {
      vault.skipped.push({ path, reason: "trashed" });
      for (const a of json.attachments ?? []) {
        const f = a.filePath && findAttachment(files, dirOf(path), a.filePath);
        if (f) trashed.add(f);
      }
      continue;
    }
    const text = richText(json.textContentHtml, json.textContent).replace(/\r\n/g, "\n");
    const list = (json.listContent ?? [])
      .map((i) => ({ text: oneLine(richText(i.textHtml, i.text, true).trim()), checked: i.isChecked }))
      .filter((i) => i.text)
      .map((i) => `- [${i.checked ? "x" : " "}] ${i.text}`)
      .join("\n");
    // A title with a line break: its first line names the note, every line is an alias.
    const titleLines = (json.title ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const title = titleLines[0] || text.split("\n")[0]?.trim().slice(0, 60) || stemOf(path);
    if (!text.trim() && !list && !(json.attachments ?? []).length) {
      vault.skipped.push({ path, reason: "empty" });
      continue;
    }
    const folder = json.isArchived ? "Archive" : "";
    const notePath = claimPath(taken, `${folder ? `${folder}/` : ""}${safeName(title)}.md`);
    const parts: string[] = [];
    if (text.trim()) parts.push(text.trim());
    if (list) parts.push(list);
    const annotations = annotationsList(json.annotations);
    const embeds: string[] = [];
    for (const a of json.attachments ?? []) {
      if (!a.filePath) continue;
      const src = findAttachment(files, dirOf(path), a.filePath);
      if (!src) {
        vault.warnings.push({ path: notePath, reason: "missingAttachment", detail: a.filePath });
        continue;
      }
      used.add(src);
      const target = claimPath(taken, `attachments/${safeName(stemOf(src))}${src.match(/\.[^./]+$/)?.[0]?.toLowerCase() ?? ""}`);
      vault.attachments.set(target, files.get(src)!);
      embeds.push(mdEmbed(target, dirOf(notePath)));
    }
    if (embeds.length) parts.push(embeds.join("\n"));
    if (annotations) parts.push(annotations);
    const props = {
      created: usec(json.createdTimestampUsec),
      // A note never edited (0) was last changed when it was made.
      updated: usec(json.userEditedTimestampUsec) ?? usec(json.createdTimestampUsec),
      aliases: titleLines.length > 1 ? titleLines : undefined,
      tags: (json.labels ?? []).map((l) => tagValue(l.name ?? "")).filter(Boolean),
      color: json.color && json.color !== "DEFAULT" ? json.color.toLowerCase() : undefined,
      pinned: json.isPinned ? true : undefined,
      archived: json.isArchived ? true : undefined,
      task: json.tasks?.length ? true : undefined,
    };
    vault.notes.set(notePath, withFrontmatter(props, `# ${title}\n\n${parts.join("\n\n")}\n`));
  }
  for (const p of files.keys()) {
    if (/\.json$/i.test(p)) continue;
    if (/\.html$/i.test(p)) {
      vault.skipped.push({ path: p, reason: "duplicate" });
      continue;
    }
    if (/(^|\/)Labels\.txt$/i.test(p)) {
      vault.skipped.push({ path: p, reason: "appFolder" });
      continue;
    }
    if (trashed.has(p) && !used.has(p)) {
      vault.skipped.push({ path: p, reason: "trashed" });
      continue;
    }
    vault.sourceAttachments++;
    if (used.has(p)) continue;
    // A file no note points at (Takeout keeps drawings and recordings this way): kept, never dropped.
    const target = claimPath(taken, `attachments/${safeName(stemOf(p))}${p.match(/\.[^./]+$/)?.[0]?.toLowerCase() ?? ""}`);
    vault.attachments.set(target, files.get(p)!);
  }
  return vault;
}
