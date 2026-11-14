import type { Root, Element, Text } from "hast";
import { visit } from "unist-util-visit";
import { BlockCache } from "./blockCache";
import { DARK_DATA_KEY } from "./renderProtocol";

/**
 * Highlighted blocks, keyed by a hash of (theme, language, source) (plan 8.1
 * step 2): after an edit only the code blocks that changed go through Shiki
 * again. The pipeline runs in the render worker (./render.worker.ts) when
 * there is one, so this cache lives there.
 */
const highlighted = new BlockCache<{ lang: string; pre: Element }>(500);

/** Blocks highlighted by Shiki since load, and blocks taken from the cache (a test counter). */
export const shikiStats = { highlighted: 0, cached: 0 };

/** Forget the kept highlights (tests). */
export function clearShikiCache(): void {
  highlighted.clear();
  shikiStats.highlighted = 0;
  shikiStats.cached = 0;
}

let highlighterPromise: Promise<unknown> | null = null;
const loadedLangs = new Set<string>();
const inFlightLoads = new Map<string, Promise<void>>();

/**
 * Pre-bundle only the six commonly-encountered languages. Anything else
 * loads lazily on first appearance via `highlighter.loadLanguage(lang)`.
 *
 * Why six and not zero: the renderer pipeline hits a code block on
 * almost every doc, and the inline-import roundtrip for the very first
 * highlight adds visible latency. JS/TS/JSON/Markdown/Bash/Python cover
 * ≈ 80% of real-world docs; the rest pay a one-time ~120 KB extra fetch
 * the first time their language is seen.
 */
const PRELOADED_LANGS = [
  "javascript",
  "typescript",
  "json",
  "markdown",
  "bash",
  "python",
];

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import("shiki");
      const hl = await createHighlighter({
        themes: ["github-dark-default", "github-light-default"],
        langs: PRELOADED_LANGS,
      });
      for (const l of PRELOADED_LANGS) loadedLangs.add(l);
      return hl;
    })();
  }
  interface ShikiHighlighter {
    codeToHast: (source: string, options: Record<string, unknown>) => Root;
    loadLanguage: (lang: string) => Promise<void>;
  }
  return highlighterPromise as Promise<ShikiHighlighter>;
}

/**
 * On-demand loader. Returns the resolved language tag once it's loaded
 * — falls back to `"text"` when the bundle doesn't ship the language at
 * all (so we never throw and the renderer always produces something).
 */
async function ensureLang(lang: string): Promise<string> {
  if (!lang || lang === "text") return "text";
  if (loadedLangs.has(lang)) return lang;
  // De-dupe concurrent loads for the same language.
  let inFlight = inFlightLoads.get(lang);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const hl = await getHighlighter();
        await hl.loadLanguage(lang);
        loadedLangs.add(lang);
      } catch {
        /* why: unsupported lang — leave it unloaded; we'll fall back to text */
      }
    })();
    inFlightLoads.set(lang, inFlight);
  }
  await inFlight;
  return loadedLangs.has(lang) ? lang : "text";
}

interface ShikiOpts {
  isDark: () => boolean;
}

/**
 * rehype plugin: highlights `<pre><code class="language-X">` blocks using Shiki.
 * Skips elements that already have a `data-lumen-block` attribute.
 */
export function rehypeShiki(opts: ShikiOpts) {
  return async function transformer(tree: Root, file?: { data?: Record<string, unknown> }) {
    const fileDark = file?.data?.[DARK_DATA_KEY];
    const isDark = typeof fileDark === "boolean" ? () => fileDark : opts.isDark;
    const tasks: Array<() => Promise<void>> = [];
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre") return;
      if (!parent || index === undefined) return;
      const codeChild = node.children.find(
        (c) => c.type === "element" && (c as Element).tagName === "code",
      ) as Element | undefined;
      if (!codeChild) return;

      // Skip our custom blocks (already have hName set elsewhere)
      const cls = (codeChild.properties?.className as string[] | undefined) ?? [];
      const langClass = cls.find((c) => c.startsWith("language-"));
      const lang = langClass?.replace("language-", "") ?? "text";

      // Get raw source from text children
      const source =
        codeChild.children
          .filter((c): c is Text => c.type === "text")
          .map((c) => c.value)
          .join("") ?? "";

      tasks.push(async () => {
        try {
          const dark = isDark();
          const key = `${dark ? 1 : 0}\u0000${lang}\u0000${source}`;
          const kept = highlighted.get(key);
          let safeLang: string;
          let newPre: Element | undefined;
          if (kept) {
            shikiStats.cached++;
            safeLang = kept.lang;
            newPre = structuredClone(kept.pre);
          } else {
            ({ safeLang, newPre } = await highlight(source, lang, dark));
            if (!newPre) return;
            shikiStats.highlighted++;
            highlighted.set(key, { lang: safeLang, pre: structuredClone(newPre) });
          }
          if (!newPre) return;

          // Wrap with our header (filename + lang chip + copy button).
          const filename = parseFilenameMeta(codeChild);
          const wrapper: Element = {
            type: "element",
            tagName: "div",
            // Code reads left-to-right whatever the note's direction (T25).
            properties: { className: ["code-block"], dir: "ltr" },
            children: [
              {
                type: "element",
                tagName: "div",
                properties: { className: ["code-block-header"] },
                children: [
                  {
                    type: "element",
                    tagName: "span",
                    properties: { className: ["lang"] },
                    children: [{ type: "text", value: filename ?? safeLang }],
                  },
                  {
                    type: "element",
                    tagName: "button",
                    properties: {
                      className: ["icon-btn"],
                      "data-copy": source,
                      title: "Copy",
                      style:
                        "padding:2px 8px;font-size:11px;height:24px;width:auto;",
                    },
                    children: [{ type: "text", value: "Copy" }],
                  },
                ],
              },
              newPre,
            ],
          };
          parent.children[index] = wrapper;
        } catch {
          // why: leave the original code block untouched on failure
        }
      });
    });
    // One block per task, yielding to the browser between blocks (C1): a
    // document with dozens of code blocks used to highlight in one long
    // main-thread task — the biggest share of the startup blocking time.
    for (const fn of tasks) {
      const before = shikiStats.highlighted;
      await fn();
      if (shikiStats.highlighted !== before) await new Promise<void>((r) => setTimeout(r, 0));
    }
  };
}

/** One block through Shiki: the language it was highlighted as (`text` when not bundled) and its `<pre>`. */
async function highlight(source: string, lang: string, dark: boolean): Promise<{ safeLang: string; newPre: Element | undefined }> {
  const hl = await getHighlighter();
  // Lazy-load the language the first time it's encountered.
  // Falls back to "text" when the language isn't bundled.
  const safeLang = await ensureLang(lang);
  const themed = hl.codeToHast(source, {
    lang: safeLang,
    themes: {
      dark: "github-dark-default",
      light: "github-light-default",
    },
    defaultColor: dark ? "dark" : "light",
    cssVariablePrefix: "--shiki-",
  });
  // Shiki's codeToHast returns a Root with a single <pre><code> element.
  const newPre = (themed as Root).children.find((c) => c.type === "element" && (c as Element).tagName === "pre") as Element | undefined;
  return { safeLang, newPre };
}

function parseFilenameMeta(codeNode: Element): string | null {
  // Look for a data-meta attribute injected by remark-mdast metas
  const meta =
    (codeNode.data as { meta?: string } | undefined)?.meta ??
    (codeNode.properties?.metastring as string | undefined);
  if (!meta) return null;
  const m = meta.match(/(?:title|filename|file)=["']?([^"'\s]+)["']?/);
  return m?.[1] ?? null;
}
