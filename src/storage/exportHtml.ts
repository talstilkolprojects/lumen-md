import { renderMarkdown } from "../renderer/pipeline";
import { fetchWithRetry } from "../lib/fetchRetry";
import { markdownBaseDirection, scriptLanguage, type BaseDirection } from "../lib/textDirection";
import { escapeHtml } from "../lib/escapeHtml";

export interface HtmlDocumentOptions {
  /** <title> text. */
  title: string;
  /** Render in dark mode (adds `class="dark"` and dark code themes). */
  isDark?: boolean;
  /** CSS inlined into the document's <style> block. */
  styles?: string;
  /** Extra markup appended to <head> (e.g. a stylesheet <link>). */
  head?: string;
  /** Markup inserted before the rendered body (e.g. a nav bar). */
  before?: string;
  /**
   * `lang` attribute of <html>. Defaults to "he" / "ar" when the document's
   * first strong character is Hebrew / Arabic, else "en".
   */
  lang?: string;
  /**
   * `dir` attribute of <html>. Defaults to the document's base direction
   * (first strong character outside frontmatter and code, or a frontmatter
   * `dir:` key), so a Hebrew note opens right-to-left anywhere.
   */
  dir?: BaseDirection;
}

/**
 * Render Markdown to a complete, standalone HTML document string. DOM-free
 * (works in Node — used by the `lumen publish` CLI); `exportToHtml` wraps it
 * with the page's live stylesheets and a browser download.
 */
export async function renderHtmlDocument(
  markdown: string,
  opts: HtmlDocumentOptions,
): Promise<string> {
  const isDark = Boolean(opts.isDark);
  const dir = opts.dir ?? markdownBaseDirection(markdown);
  const lang = opts.lang ?? (dir === "rtl" ? scriptLanguage(markdown) : null) ?? "en";
  // Render to a React tree, then stringify.
  const tree = await renderMarkdown(markdown, () => isDark);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { StaticRenderContext } = await import("../renderer/components");
  // Static mode: interactive blocks serialize as their source instead of a
  // never-hydrated "Loading…" placeholder.
  const body = renderToStaticMarkup(
    createElement(StaticRenderContext.Provider, { value: true }, tree as React.ReactElement),
  );

  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${dir}" class="${isDark ? "dark" : ""}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="Lumen" />
<title>${escapeHtml(opts.title)}</title>
<style>
${opts.styles ?? ""}

/* Self-contained tweaks */
body {
  margin: 0;
  padding: 2.5rem 1rem;
  background: hsl(var(--bg));
  color: hsl(var(--fg));
}
.lumen-export {
  max-width: 760px;
  margin: 0 auto;
}
@media print {
  body { padding: 0; }
  .code-block, .chart-block, .mermaid-block { break-inside: avoid; }
}
</style>${opts.head ?? ""}
</head>
<body>
${opts.before ?? ""}<main class="prose-lumen lumen-export">
${body}
</main>
</body>
</html>`;
}

/**
 * Render the markdown to a self-contained HTML document and trigger a
 * download. Inlines all stylesheets currently attached to the page, including
 * the bundled Vite CSS, KaTeX, and Leaflet — so the resulting file looks the
 * same as the live preview when opened anywhere.
 */
export async function exportToHtml(
  markdown: string,
  filename: string,
): Promise<void> {
  const isDark = document.documentElement.classList.contains("dark");
  const styles = await collectStyles();
  const docTitle = (filename.replace(/\.(md|markdown|html)$/i, "") || "Document").trim();
  const html = await renderHtmlDocument(markdown, { title: docTitle, isDark, styles });

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (filename.replace(/\.(md|markdown)$/i, "") || "document") + ".html";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Inline all current stylesheets (including <style> tags and external <link>s
 * already loaded by the page).
 */
async function collectStyles(): Promise<string> {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        chunks.push(rule.cssText);
      }
    } catch {
      // Cross-origin stylesheet (Google Fonts, etc.) — fetch its text directly.
      const href = (sheet as CSSStyleSheet).href;
      if (!href) continue;
      try {
        const res = await fetchWithRetry(href, {}, { label: "exportHtml.stylesheet", maxRetries: 2, baseDelayMs: 600, maxDelayMs: 2500 });
        if (res.ok) chunks.push(await res.text());
      } catch {
        /* why: network unavailable; skip */
      }
    }
  }
  return chunks.join("\n");
}

/** Re-exported from ../lib/escapeHtml (plan 4.18: the site builder needs it without the renderer). */
export { escapeHtml };
