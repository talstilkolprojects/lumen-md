/**
 * Clip templates and triggers (plan 4.15.1, 4.15.5), after the Obsidian Web
 * Clipper (MIT, © 2024 Obsidian): a template says where the note goes, what
 * it is called and what its frontmatter and body hold, written with
 * `{{variables}}`; triggers pick the template from the page address (a URL
 * prefix, or `/regex/`) or its schema.org type (`schema:@Recipe`). The first
 * template whose trigger matches wins; with none, the default.
 *
 * Code is ours, the model is theirs; no Obsidian name or mark is used.
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
export const SITE_TEMPLATES: ClipTemplate[] = [
  {
    id: "wikipedia",
    name: "Wikipedia",
    path: "{{library}}/Wikipedia",
    noteName: "{{title}}",
    properties: [...DEFAULT_TEMPLATE.properties.filter((p) => p.name !== "author" && p.name !== "tags"), { name: "license", value: "CC BY-SA 4.0" }, { name: "tags", value: "[clip, wikipedia]" }],
    content: BODY,
    triggers: ["/^https?:\\/\\/([a-z-]+\\.)?(m\\.)?wikipedia\\.org\\/wiki\\//"],
  },
  {
    id: "ynet",
    name: "ynet",
    path: "{{library}}/ynet",
    noteName: "{{title}}",
    properties: [...DEFAULT_TEMPLATE.properties.filter((p) => p.name !== "tags"), { name: "tags", value: "[clip, news]" }],
    content: BODY,
    triggers: ["https://www.ynet.co.il/", "https://ynet.co.il/", "https://www.ynetnews.com/"],
  },
  {
    id: "haaretz",
    name: "Haaretz",
    path: "{{library}}/Haaretz",
    noteName: "{{title}}",
    properties: [...DEFAULT_TEMPLATE.properties.filter((p) => p.name !== "tags"), { name: "tags", value: "[clip, news]" }],
    content: BODY,
    triggers: ["https://www.haaretz.co.il/", "https://www.haaretz.com/"],
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
  return text.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_m, name: string, filter?: string) => {
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

export function varsFor(page: Extracted, url: string, extra: { selection?: string; highlights?: string; library: string; date?: Date }): ClipVars {
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
  };
}
