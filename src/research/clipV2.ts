/**
 * Web clipper v2 (plan 4.15): extract → template → injection guard → note.
 *
 * Clips reach the app in three ways, none of which needs a server
 * (4.15.2; the old extension POSTed to `/api/clip`, which never existed):
 *
 *  - the extension's bridge content script, injected on the app's own
 *    origin, hands the clip over with `window.postMessage` (an extension
 *    cannot trigger a PWA share_target);
 *  - on the desktop, the deep link `lumen://clip?data=…` (Tauri passes it
 *    to the window as a `lumen-deep-link` event);
 *  - otherwise the extension opens the app with `#clip=<json>`.
 *
 * Every clip is outside content: its frontmatter carries `source:` (so the
 * prompt-injection guard of plan 2.7 treats the note as untrusted), and its
 * text is checked for hidden or instruction-like passages before saving;
 * what was found is written into the note, visibly.
 */
import { extractPage, htmlToMd, type Extracted } from "./clipExtract";
import { pickTemplate, renderClip, varsFor, type ClipTemplate, type RenderedClip } from "./clipTemplates";
import { addHighlights, highlightsFor, highlightsMarkdown } from "./clipHighlights";

/** What the extension (or a deep link) sends. */
export interface ClipPayload {
  url: string;
  /** The page's full HTML (document.documentElement.outerHTML). */
  html?: string;
  /** The selection as HTML, when the user clipped only part of the page. */
  selectionHtml?: string;
  /** Highlighted passages (text) on this page. */
  highlights?: string[];
  /** Legacy v1 payload: title + markdown already made by the extension. */
  title?: string;
  markdown?: string;
}

const MAX_HTML = 8 * 1024 * 1024;

/** A payload from outside, checked field by field; null when it isn't one. */
export function parsePayload(v: unknown): ClipPayload | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).length <= MAX_HTML ? (o[k] as string) : undefined);
  const highlights = Array.isArray(o.highlights) ? o.highlights.filter((h): h is string => typeof h === "string").slice(0, 200) : undefined;
  const p: ClipPayload = { url, html: str("html"), selectionHtml: str("selectionHtml"), highlights, title: str("title"), markdown: str("markdown") };
  if (!p.html && !p.selectionHtml && !p.markdown) return null;
  return p;
}

export interface BuiltClip extends RenderedClip {
  title: string;
  source: string;
  engine: Extracted["engine"];
  /** Hidden or instruction-like passages found and marked in the note. */
  flagged: number;
  template: string;
}

/** Build the note for a clip. */
export async function buildClip(p: ClipPayload, opts: { library: string; templates?: ClipTemplate[]; date?: Date }): Promise<BuiltClip> {
  const page: Extracted = p.html
    ? extractPage(p.html, p.url)
    : { title: p.title ?? "", author: "", published: "", site: "", description: "", language: "", html: "", markdown: p.markdown ?? "", wordCount: 0, engine: "none" };
  if (!page.title && p.title) page.title = p.title;
  const selection = p.selectionHtml ? htmlToMd(p.selectionHtml) : "";
  const stored = p.highlights?.length ? addHighlights(p.url, p.highlights) : highlightsFor(p.url);
  let schema: unknown = null;
  if (p.html) {
    try {
      const doc = new DOMParser().parseFromString(p.html, "text/html");
      schema = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
        try {
          return JSON.parse(s.textContent ?? "null");
        } catch {
          return null;
        }
      });
    } catch {
      schema = null;
    }
  }
  const template = pickTemplate(p.url, schema, opts.templates);
  const vars = varsFor(page, p.url, { selection, highlights: highlightsMarkdown(stored), library: opts.library, date: opts.date });
  // Injection guard (plan 2.7) on what came from the page.
  const { sanitizeUntrusted, summarizeFindings } = await import("../agents/untrusted");
  let flagged = 0;
  for (const k of ["content", "title", "author", "description", "selection"] as const) {
    const s = sanitizeUntrusted(vars[k]);
    flagged += s.findings.length;
    vars[k] = k === "content" || k === "selection" ? s.text : s.text.replace(/\s+/g, " ").trim();
    if (k === "content" && s.findings.length) vars.content = `> [!warning] ${summarizeFindings(s.findings)}\n\n${vars.content}`;
  }
  const rendered = renderClip(template, vars);
  return { ...rendered, title: vars.title, source: p.url, engine: page.engine, flagged, template: template.id };
}

/** Clip from a URL hash (`#clip=<json>`), removing it so a reload doesn't repeat it. */
export function takeHashPayload(): ClipPayload | null {
  if (typeof location === "undefined") return null;
  const m = /[#&]clip=([^&]+)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    return parsePayload(JSON.parse(decodeURIComponent(m[1])));
  } catch {
    return null;
  }
}

/** `lumen://clip?data=<json>` (desktop deep link). */
export function parseDeepLink(link: string): ClipPayload | null {
  try {
    const u = new URL(link);
    if (u.protocol !== "lumen:" || (u.hostname !== "clip" && !u.pathname.replace(/^\/+/, "").startsWith("clip"))) return null;
    const data = u.searchParams.get("data");
    return data ? parsePayload(JSON.parse(data)) : null;
  } catch {
    return null;
  }
}
