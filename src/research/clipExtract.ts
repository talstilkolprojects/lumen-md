/**
 * Web clipper v2 extraction (plan 4.15.1 / 4.15.3).
 *
 * The readable part of a page, and its metadata, from the same engine the
 * Obsidian Web Clipper uses: Defuddle (MIT). When Defuddle finds nothing
 * worth keeping, Mozilla Readability 0.6 (Apache-2.0) is the fallback. Both
 * need a DOM, so this runs on the main thread (DOMParser), never in a worker.
 * Turndown (MIT) turns the HTML into Markdown.
 *
 * Everything here is loaded lazily (the clip commands import it on use):
 * nothing is on the startup path.
 */
import Defuddle from "defuddle";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

export interface Extracted {
  title: string;
  author: string;
  published: string;
  site: string;
  description: string;
  language: string;
  /** The article as HTML (links and images absolute). */
  html: string;
  markdown: string;
  wordCount: number;
  /** Which engine produced the content. */
  engine: "defuddle" | "readability" | "none";
}

/** The page's title, without the " — Site name" tail most sites add. */
export function cleanTitle(title: string, site: string, doc?: Document): string {
  let t = title.trim();
  if (!t) return t;
  const h1 = doc?.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
  // The headline wins when the <title> is "headline <sep> site".
  if (h1 && h1.length >= 3 && t.startsWith(h1) && /^\s*[—–\-|:·•]/.test(t.slice(h1.length))) return h1;
  for (const name of [site, doc?.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() ?? ""]) {
    if (!name) continue;
    const m = new RegExp(`\\s*[—–\\-|:·•]\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).exec(t);
    if (m && m.index > 0) t = t.slice(0, m.index).trim();
  }
  return t;
}

let turndown: TurndownService | null = null;
function md(): TurndownService {
  if (turndown) return turndown;
  turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*", hr: "---" });
  // Fenced code keeps its language (Defuddle marks it as data-lang / language-x).
  turndown.addRule("fencedLang", {
    filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
    replacement: (_c, node) => {
      const code = (node as Element).querySelector("code")!;
      const lang = code.getAttribute("data-lang") || /language-([\w-]+)/.exec(code.className)?.[1] || "";
      const text = code.textContent ?? "";
      const fence = /```/.test(text) ? "````" : "```";
      return `\n\n${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
    },
  });
  // Footnote / figure captions and similar stay plain text.
  turndown.remove(["script", "style", "noscript", "template", "iframe", "form", "button"]);
  return turndown;
}

export function htmlToMd(html: string): string {
  return md().turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

const textLength = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;

/** Extract a page. `url` resolves relative links and picks site rules. */
export function extractPage(html: string, url?: string): Extracted {
  const parse = () => new DOMParser().parseFromString(html, "text/html");
  const probe = parse();
  let out: Omit<Extracted, "markdown"> = { title: "", author: "", published: "", site: "", description: "", language: "", html: "", wordCount: 0, engine: "none" };
  try {
    const r = new Defuddle(parse(), { url }).parse();
    out = { title: r.title ?? "", author: r.author ?? "", published: r.published ?? "", site: r.site ?? "", description: r.description ?? "", language: r.language ?? "", html: r.content ?? "", wordCount: r.wordCount ?? 0, engine: "defuddle" };
  } catch {
    /* why: Defuddle failed on this page: Readability below */
  }
  if (textLength(out.html) < 140) {
    try {
      const r = new Readability(parse(), { keepClasses: false }).parse();
      if (r?.content && textLength(r.content) > textLength(out.html)) {
        out = {
          ...out,
          title: out.title || r.title || "",
          author: out.author || r.byline || "",
          published: out.published || r.publishedTime || "",
          site: out.site || r.siteName || "",
          description: out.description || r.excerpt || "",
          language: out.language || r.lang || "",
          html: r.content,
          wordCount: (r.textContent ?? "").split(/\s+/).filter(Boolean).length,
          engine: "readability",
        };
      }
    } catch {
      /* why: neither engine could read it: an empty clip, said so by the caller */
    }
  }
  if (url) out.html = absolutize(out.html, url);
  const title = cleanTitle(out.title || probe.title || "", out.site, probe);
  return { ...out, title, markdown: out.html ? htmlToMd(out.html) : "" };
}

/** Links and images point at the clipped page, never at Lumen. */
function absolutize(html: string, url: string): string {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return html;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const attr of ["href", "src", "poster"]) {
    doc.body.querySelectorAll(`[${attr}]`).forEach((el) => {
      try {
        el.setAttribute(attr, new URL(el.getAttribute(attr)!.trim(), base).href);
      } catch {
        /* why: keep a broken value as it was */
      }
    });
  }
  doc.body.querySelectorAll("[srcset]").forEach((el) => el.removeAttribute("srcset"));
  return doc.body.innerHTML;
}
