/**
 * Web clipper and reading library (T34).
 *
 * A page is saved into the vault as Markdown — the readable part of it,
 * not the menus — with its source and the date it was clipped, under the
 * library folder. The library is part of the vault, so it is indexed for
 * search and "Ask the vault" like any note, and it is what research uses
 * when nothing may leave the device (local-only policy).
 */
import { htmlToMarkdown } from "../storage/fileFormats";

export const LIBRARY_DIR = { en: "Library", he: "ספרייה" } as const;
export const libraryDir = (lang: string) => (lang === "he" ? LIBRARY_DIR.he : LIBRARY_DIR.en);
export const isLibraryPath = (p: string) => p.startsWith(`${LIBRARY_DIR.en}/`) || p.startsWith(`${LIBRARY_DIR.he}/`);

export interface Clip {
  title: string;
  source: string;
  markdown: string;
}

const DROP = "script,style,noscript,template,nav,footer,aside,form,iframe,svg,button,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],.ad,.ads,.advert,.cookie,.newsletter,.share,.social";
const CONTENT = "article,main,[role=main]";

/** Absolute http(s) base for resolving the page's links, or null. */
function baseUrl(doc: Document, source?: string): URL | null {
  let base: URL;
  try {
    base = new URL(source ?? "");
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  const declared = doc.querySelector("base[href]")?.getAttribute("href");
  if (declared) {
    try {
      const b = new URL(declared, base);
      if (b.protocol === "http:" || b.protocol === "https:") base = b;
    } catch {
      /* why: ignore a broken <base> */
    }
  }
  return base;
}

/**
 * Point links and images at the clipped page, not at Lumen: `/next` or
 * `../photo.jpg` would otherwise resolve against the app or the vault.
 */
function absolutizeUrls(root: Element, base: URL): void {
  const abs = (v: string) => {
    try {
      return new URL(v.trim(), base).href;
    } catch {
      return v;
    }
  };
  for (const attr of ["href", "src", "poster"]) {
    root.querySelectorAll(`[${attr}]`).forEach((el) => el.setAttribute(attr, abs(el.getAttribute(attr) ?? "")));
  }
  root.querySelectorAll("[srcset]").forEach((el) => {
    const set = (el.getAttribute("srcset") ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [u, ...rest] = c.split(/\s+/);
        return [abs(u), ...rest].join(" ");
      });
    el.setAttribute("srcset", set.join(", "));
  });
}

/** The readable part of an HTML page (article > main > biggest text block). */
export function readableHtml(html: string, source?: string): { title: string; html: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    doc.title?.trim() ||
    "";
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  // A <header> inside the article / main holds its headline, byline and
  // lead; only the site header outside it is chrome.
  doc.querySelectorAll("header").forEach((el) => {
    if (!el.closest(CONTENT)) el.remove();
  });
  let root: Element | null = doc.querySelector("article") ?? doc.querySelector("main") ?? doc.querySelector("[role=main]");
  if (!root) {
    // The element with the most paragraph text.
    let best: Element | null = null;
    let bestLen = 0;
    doc.querySelectorAll("div,section").forEach((el) => {
      const len = [...el.querySelectorAll(":scope > p")].reduce((n, p) => n + (p.textContent?.length ?? 0), 0);
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    });
    root = best ?? doc.body;
  }
  const base = baseUrl(doc, source);
  if (root && base) absolutizeUrls(root, base);
  return { title, html: root?.innerHTML ?? "" };
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** Markdown note for a clipped page: frontmatter with source and date, then the content. */
export function clipToNote(c: { title: string; source: string; body: string; date?: Date }): string {
  const d = (c.date ?? new Date()).toISOString().slice(0, 10);
  return [
    "---",
    `title: ${yamlString(c.title || c.source)}`,
    `source: ${yamlString(c.source)}`,
    `clipped: ${d}`,
    "tags: [clip]",
    "---",
    "",
    `# ${c.title || c.source}`,
    "",
    `> ${c.source} · ${d}`,
    "",
    c.body.trim(),
    "",
  ].join("\n");
}

export function clipFromHtml(html: string, source: string, date?: Date): Clip {
  const { title, html: main } = readableHtml(html, source);
  const body = htmlToMarkdown(main).replace(/\n{3,}/g, "\n\n");
  return { title: title || source, source, markdown: clipToNote({ title, source, body, date }) };
}

/** A file name for a clip: the title, made safe, ≤ 80 chars. */
export function clipFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "clip";
  return `${base}.md`;
}

/**
 * Fetch and clip a URL: through the research service's extractor when one
 * is configured (no CORS limits), else straight from the browser — only
 * where the page's CSP admits that origin (connect-src is an allowlist, so
 * for ordinary article sites it doesn't, and the fetch would just fail).
 * Without a usable route: `ResearchUnavailableError`. Under the local-only
 * policy neither route runs — both make the page's site see a visit — and
 * the refusal is a `PrivacyBlockedError`, recorded in the ledger.
 */
export async function clipUrl(url: string, deps: { extract?: (u: string) => Promise<{ title?: string; text?: string; finalUrl?: string; error?: string }> } = {}): Promise<Clip> {
  // Either route makes the page's site see a visit (the research service
  // fetches it for us), so local-only refuses here, before both (plan 2.4).
  const { guardedFetch, refuseIfBlocked } = await import("../ai/privacyLedger");
  const clipper = { category: "third-party" as const, reason: "Web clipper — fetches the page you clip" };
  refuseIfBlocked(url, { ...clipper, quiet: true }); // the clip command shows its own local-only hint
  const { researchEndpoint, extractPage, ResearchUnavailableError } = await import("./client");
  const extract = deps.extract ?? (researchEndpoint() ? (u: string) => extractPage(u) : null);
  let extractError: string | undefined;
  if (extract) {
    const page = await extract(url);
    if (!page.error && page.text) {
      const source = page.finalUrl || url;
      return { title: page.title || source, source, markdown: clipToNote({ title: page.title || "", source, body: page.text }) };
    }
    extractError = page.error;
  }
  const { connectAllowedByCsp } = await import("../lib/cspConnect");
  if (!connectAllowedByCsp(url)) {
    if (extractError) throw new Error(extractError);
    throw new ResearchUnavailableError();
  }
  // The page's site sees the visit: logged as third-party traffic (plan 2.4).
  const res = await guardedFetch(url, { credentials: "omit" }, clipper);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return clipFromHtml(await res.text(), res.url || url);
}
