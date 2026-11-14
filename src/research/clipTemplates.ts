/**
 * Clip templates and triggers (plan 4.15.1, 4.15.5), after the Obsidian Web
 * Clipper (MIT, © 2024 Obsidian): a template says where the note goes, what
 * it is called and what its frontmatter and body hold, written with
 * `{{variables}}`; triggers pick the template from the page address (a URL
 * prefix, or `/regex/`) or its schema.org type (`schema:@Recipe`). The first
 * template whose trigger matches wins; with none, the default.
 *
 * Code is ours, the model is theirs; no Obsidian name or mark is used.
 *
 * Plan W2.14 adds, from the same model: `{{meta:name}}` (a <meta> tag's
 * content, by name or property), `{{selector:css}}` (the text of the
 * elements a CSS selector picks), `{{transcript}}` (a video's transcript
 * when the extension sends one) and prompt variables `{{"…"}}`, answered
 * by a local model (./clipInterpreter). Site templates for YouTube, arXiv
 * and GitHub join Wikipedia, ynet and Haaretz.
 */
import type { Extracted } from "./clipExtract";

export interface ClipTemplate {
  id: string;
  name: string;
  /** Folder inside the vault ("{{library}}" = the clip library for the UI language). */
  path: string;
  /** File name without .md. */
  noteName: string;
  properties: Array<{ name: string; value: string }>;
  /** Markdown body. */
  content: string;
  triggers?: string[];
  /**
   * Plan W2.14: the CSS selectors whose text the interpreter reads for this
   * template's prompt variables (`{{"…"}}`), instead of the whole article —
   * a small model's context stays small.
   */
  context?: string;
}

export interface ClipVars {
  title: string;
  url: string;
  domain: string;
  author: string;
  published: string;
  site: string;
  description: string;
  date: string;
  content: string;
  selection: string;
  highlights: string;
  library: string;
  /** A video's transcript, when the extension sent one (W2.14). */
  transcript: string;
  [k: string]: string;
}

const BODY = "# {{title}}\n\n> {{url}} · {{date}}\n\n{{highlights}}{{content}}\n";

export const DEFAULT_TEMPLATE: ClipTemplate = {
  id: "default",
  name: "Default",
  path: "{{library}}",
  noteName: "{{title}}",
  properties: [
    { name: "title", value: "{{title}}" },
    { name: "source", value: "{{url}}" },
    { name: "author", value: "{{author}}" },
    { name: "published", value: "{{published}}" },
    { name: "clipped", value: "{{date}}" },
    { name: "tags", value: "[clip]" },
  ],
  content: BODY,
};

/**
 * Built-in site templates (4.15.5). The news sites are checked live and
 * locally only; their pages are never stored as golden data.
 */
/** The interpreter's summary field (W2.14): empty — and so left out — when no local model is available. */
const SUMMARY = { name: "summary", value: '{{"a one-sentence summary of the page, in the page\'s language"}}' };
const TOPICS = { name: "topics", value: '{{"three to five key topics of the page, comma-separated, in the page\'s language"|lower}}' };

export const SITE_TEMPLATES: ClipTemplate[] = [
  {
    id: "wikipedia",
    name: "Wikipedia",
    path: "{{library}}/Wikipedia",
    noteName: "{{title}}",
    properties: [...DEFAULT_TEMPLATE.properties.filter((p) => p.name !== "author" && p.name !== "tags"), { name: "license", value: "CC BY-SA 4.0" }, SUMMARY, { name: "tags", value: "[clip, wikipedia]" }],
    content: BODY,
    triggers: ["/^https?:\\/\\/([a-z-]+\\.)?(m\\.)?wikipedia\\.org\\/wiki\\//"],
    // The lead section is the summary of the article.
    context: "#firstHeading, .mw-parser-output > p",
  },
  {
    id: "ynet",
    name: "ynet",
    path: "{{library}}/ynet",
    noteName: "{{title}}",
    properties: [...DEFAULT_TEMPLATE.properties.filter((p) => p.name !== "tags"), SUMMARY, TOPICS, { name: "tags", value: "[clip, news]" }],
    content: BODY,
    triggers: ["https://www.ynet.co.il/", "https://ynet.co.il/", "https://www.ynetnews.com/"],
    context: "h1, .mainTitle, .subTitle, .text_editor_paragraph, article p",
  },
  {
    id: "haaretz",
    name: "Haaretz",
    path: "{{library}}/Haaretz",
    noteName: "{{title}}",
    properties: [...DEFAULT_TEMPLATE.properties.filter((p) => p.name !== "tags"), SUMMARY, TOPICS, { name: "tags", value: "[clip, news]" }],
    content: BODY,
    triggers: ["https://www.haaretz.co.il/", "https://www.haaretz.com/"],
    context: "h1, article p",
  },
  {
    id: "youtube",
    name: "YouTube",
    path: "{{library}}/YouTube",
    noteName: "{{title}}",
    properties: [
      { name: "title", value: "{{title}}" },
      { name: "source", value: "{{url}}" },
      { name: "channel", value: "{{selector:#owner #channel-name a, ytd-channel-name a, link[itemprop=name]}}" },
      { name: "published", value: "{{meta:datePublished}}" },
      { name: "clipped", value: "{{date}}" },
      SUMMARY,
      { name: "tags", value: "[clip, video]" },
    ],
    content: "# {{title}}\n\n> {{url}} · {{date}}\n\n{{description}}\n\n{{transcript}}\n",
    triggers: ["https://www.youtube.com/watch", "https://youtube.com/watch", "https://m.youtube.com/watch", "https://youtu.be/"],
    // The transcript when the extension sent one, else the description.
    context: "meta[name=description], #description",
  },
  {
    id: "arxiv",
    name: "arXiv",
    path: "{{library}}/arXiv",
    noteName: "{{meta:citation_title}}",
    properties: [
      { name: "title", value: "{{meta:citation_title}}" },
      { name: "source", value: "{{url}}" },
      { name: "authors", value: "{{meta:citation_author}}" },
      { name: "arxiv", value: "{{meta:citation_arxiv_id}}" },
      { name: "published", value: "{{meta:citation_date}}" },
      { name: "pdf", value: "{{meta:citation_pdf_url}}" },
      { name: "clipped", value: "{{date}}" },
      { name: "contribution", value: '{{"the paper\'s main contribution in one sentence"}}' },
      { name: "tags", value: "[clip, paper]" },
    ],
    content: "# {{meta:citation_title}}\n\n> {{url}} · {{date}}\n\n## Abstract\n\n{{selector:blockquote.abstract}}\n",
    triggers: ["/^https?:\\/\\/(www\\.)?arxiv\\.org\\/abs\\//"],
    // The abstract says what the paper does.
    context: "blockquote.abstract",
  },
  {
    id: "github",
    name: "GitHub",
    path: "{{library}}/GitHub",
    noteName: "{{meta:og:title}}",
    properties: [
      { name: "title", value: "{{meta:og:title}}" },
      { name: "source", value: "{{url}}" },
      { name: "description", value: "{{meta:og:description}}" },
      { name: "clipped", value: "{{date}}" },
      { name: "purpose", value: '{{"what the project is for, in one sentence"}}' },
      { name: "tags", value: "[clip, code]" },
    ],
    content: BODY,
    triggers: ["/^https:\\/\\/github\\.com\\/[^/]+\\/[^/]+/"],
    context: "[itemprop=about], .f4.my-3, article.markdown-body h1, article.markdown-body p",
  },
  {
    id: "recipe",
    name: "Recipe",
    path: "{{library}}/Recipes",
    noteName: "{{title}}",
    properties: [...DEFAULT_TEMPLATE.properties.filter((p) => p.name !== "tags"), { name: "tags", value: "[clip, recipe]" }],
    content: BODY,
    triggers: ["schema:@Recipe"],
  },
];

function schemaTypes(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const t = o["@type"];
      if (typeof t === "string") out.push(t);
      else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.push(x));
      if (o["@graph"]) walk(o["@graph"]);
    }
  };
  walk(schema);
  return out;
}

const PAGE_VAR = /\{\{\s*((meta|selector):([^}|]+?))\s*(?:\|\s*\w+\s*)?\}\}/g;

/**
 * The values of a template's `{{meta:…}}` and `{{selector:…}}` variables on
 * a page (W2.14). Several <meta> tags of one name (citation_author) are
 * joined with ", "; a selector's elements' text with " ".
 */
export function pageVars(t: ClipTemplate, doc: Document | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!doc) return out;
  for (const text of [t.noteName, t.path, t.content, ...t.properties.map((p) => p.value)]) {
    for (const m of text.matchAll(PAGE_VAR)) {
      const [, key, kind, arg] = m;
      if (key in out) continue;
      const a = arg.trim();
      if (kind === "meta") {
        const values = [...doc.querySelectorAll("meta")]
          .filter((el) => el.getAttribute("name") === a || el.getAttribute("property") === a || el.getAttribute("itemprop") === a)
          .map((el) => (el.getAttribute("content") ?? "").trim())
          .filter(Boolean);
        out[key] = [...new Set(values)].join(", ");
      } else {
        let els: Element[] = [];
        try {
          els = [...doc.querySelectorAll(a)];
        } catch {
          els = [];
        }
        out[key] = els
          .map((el) => (el.getAttribute("content") ?? el.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .filter((v, i, all) => all.indexOf(v) === i)
          .join(" ");
      }
    }
  }
  return out;
}

/** Does one trigger match this page? */
export function triggerMatches(trigger: string, url: string, schema?: unknown): boolean {
  if (trigger.startsWith("schema:")) {
    const type = /^schema:@?(\w+)/.exec(trigger)?.[1];
    return !!type && schemaTypes(schema).includes(type);
  }
  if (trigger.length > 2 && trigger.startsWith("/") && trigger.endsWith("/")) {
    try {
      return new RegExp(trigger.slice(1, -1)).test(url);
    } catch {
      return false;
    }
  }
  return url.startsWith(trigger);
}

/** The template for a page: user templates first, then the built-in site ones, then the default. */
export function pickTemplate(url: string, schema: unknown, user: ClipTemplate[] = []): ClipTemplate {
  for (const t of [...user, ...SITE_TEMPLATES]) if (t.triggers?.some((tr) => triggerMatches(tr, url, schema))) return t;
  return user.find((t) => t.id === "default") ?? DEFAULT_TEMPLATE;
}

/** `{{name}}` and `{{name|filter}}` (lower, upper, trim, slug, safe). */
export function fill(text: string, vars: ClipVars): string {
  return text.replace(/\{\{\s*((?:meta|selector):[^}|]+?|[\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_m, name: string, filter?: string) => {
    let v = vars[name] ?? "";
    switch (filter) {
      case "lower":
        v = v.toLowerCase();
        break;
      case "upper":
        v = v.toUpperCase();
        break;
      case "trim":
        v = v.trim();
        break;
      case "slug":
        v = v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
        break;
      case "safe":
        v = safeName(v);
        break;
    }
    return v;
  });
}

/** A file or folder name: no path separators or characters filesystems refuse, ≤ 80 chars. */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "clip";
}

const yaml = (v: string) => (/^\[.*\]$/.test(v) ? v : JSON.stringify(v));

export interface RenderedClip {
  folder: string;
  fileName: string;
  markdown: string;
}

/** The note a template makes from a page. Empty properties are left out. */
export function renderClip(t: ClipTemplate, vars: ClipVars): RenderedClip {
  const props = t.properties.map((p) => [p.name, fill(p.value, vars).trim()] as const).filter(([, v]) => v !== "");
  const front = ["---", ...props.map(([k, v]) => `${k}: ${yaml(v)}`), "---", ""].join("\n");
  const folder = fill(t.path, vars)
    .split("/")
    .map((seg) => safeName(seg))
    .filter((seg) => seg && seg !== "clip")
    .join("/");
  return { folder: folder || vars.library, fileName: `${safeName(fill(t.noteName, vars))}.md`, markdown: `${front}\n${fill(t.content, vars).replace(/\n{3,}/g, "\n\n").trim()}\n` };
}

export function varsFor(page: Extracted, url: string, extra: { selection?: string; highlights?: string; library: string; date?: Date; transcript?: string }): ClipVars {
  let domain = "";
  try {
    domain = new URL(url).hostname;
  } catch {
    /* why: not a URL: no domain */
  }
  const date = (extra.date ?? new Date()).toISOString().slice(0, 10);
  const content = extra.selection?.trim() ? extra.selection.trim() : page.markdown;
  return {
    title: page.title || domain || url,
    url,
    domain,
    author: page.author,
    published: page.published ? page.published.slice(0, 10) : "",
    site: page.site,
    description: page.description,
    date,
    content,
    selection: extra.selection ?? "",
    highlights: extra.highlights ? `${extra.highlights}\n\n` : "",
    library: extra.library,
    // A heading with it, so a clip without a transcript has no empty section.
    transcript: extra.transcript?.trim() ? `## Transcript\n\n${extra.transcript.trim()}` : "",
  };
}
