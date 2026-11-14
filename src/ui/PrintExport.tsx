/**
 * Print / Export to PDF utility.
 *
 * Renders the markdown preview in a new window with all styles preserved,
 * then triggers window.print() which on modern browsers offers "Save as PDF".
 */

import { extractFrontmatter, renderMarkdown } from "../renderer/pipeline";
import { applyPageBreaks, buildToc, contentDirection, contentLang, printCss, printFrontmatter } from "../print/printLayout";
import { getLocale, t } from "../i18n";
import { safeSetHtml, safeClearHtml } from "../lib/trustedTypes";
import { exportReadyText } from "../storage/exportReady";

/**
 * Generate a printable document from markdown content.
 * Opens a new window with the styled preview and triggers the print dialog.
 * The user can choose "Save as PDF" from the system print dialog.
 */
export async function printDocument(
  markdownText: string,
  docName: string,
): Promise<void> {
  const { title, themeClass, dir, lang, styles, html } = await preparePrint(markdownText, docName);
  const printWindow = window.open("", "_blank");
  if (printWindow?.document) {
    hydratePrintDocument(printWindow.document, title, themeClass, dir, lang, styles, html);
    setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 120);
    return;
  }
  printInlineFallback(title, themeClass, dir, styles, html);
}

interface PreparedPrint {
  title: string;
  themeClass: string;
  dir: "rtl" | "ltr";
  lang: string;
  styles: string;
  html: string;
}

/** Render the note and lay it out for print (W2.23). Exposed for the print golden tests. */
export async function preparePrint(markdownText: string, docName: string, opts: { appStyles?: boolean } = {}): Promise<PreparedPrint> {
  const isDark = () => document.documentElement.classList.contains("dark");
  // W5.11: the PDF gets the text without its marked passages (removed, not
  // covered), and photos inlined without metadata (Chromium embeds a JPEG as is).
  const tree = await renderMarkdown(await exportReadyText(markdownText, true), isDark);

  // Serialize the React tree through a temporary root.
  const { createRoot } = await import("react-dom/client");
  const { createElement, Fragment } = await import("react");
  const temp = document.createElement("div");
  const root = createRoot(temp);
  await new Promise<void>((resolve) => {
    root.render(createElement(Fragment, null, tree));
    setTimeout(resolve, 100);
  });

  const fm = extractFrontmatter(markdownText);
  const title = docName || (typeof fm?.title === "string" ? fm.title : "") || t("print.untitled");
  const dir = contentDirection(markdownText);
  const lang = contentLang(temp.textContent ?? "", getLocale());

  applyPageBreaks(temp);
  const settings = printFrontmatter(fm);
  if (settings.toc) {
    const toc = buildToc(temp, t("print.toc"));
    if (toc) temp.prepend(toc);
  }
  const html = temp.innerHTML;
  root.unmount();

  // The app's own styles (theme, callouts, code, math, fonts), then the print layout.
  const styles: string[] = [];
  if (opts.appStyles !== false) {
    for (const sheet of document.styleSheets) {
      try {
        styles.push([...sheet.cssRules].map((r) => r.cssText).join("\n"));
      } catch {
        // why: Cross-origin sheets — skip
      }
    }
  }
  styles.push(printCss({ title, dir, ...settings }));
  return {
    title,
    // Paper is white: print in the light theme whatever the screen shows.
    themeClass: "",
    dir,
    lang,
    styles: styles.join("\n\n"),
    html,
  };
}

/** The whole print document as HTML (for tests: render it, print it to PDF). */
export async function buildPrintHtml(markdownText: string, docName: string): Promise<string> {
  const p = await preparePrint(markdownText, docName);
  const doc = document.implementation.createHTMLDocument("");
  hydratePrintDocument(doc, p.title, p.themeClass, p.dir, p.lang, p.styles, p.html);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

function hydratePrintDocument(
  targetDocument: Document,
  safeDocName: string,
  themeClass: string,
  dir: string,
  lang: string,
  safeStyles: string,
  printContent: string,
): void {
  targetDocument.open();
  targetDocument.close();

  const htmlElement = targetDocument.documentElement;
  if (!htmlElement) return;

  htmlElement.className = themeClass;
  htmlElement.setAttribute("dir", dir);
  htmlElement.setAttribute("lang", lang);
  targetDocument.title = safeDocName;

  const head = targetDocument.head;
  const body = targetDocument.body;
  if (!head || !body) return;

  const meta = targetDocument.createElement("meta");
  meta.setAttribute("charset", "utf-8");
  head.appendChild(meta);
  const styleEl = targetDocument.createElement("style");
  styleEl.textContent = safeStyles;
  head.appendChild(styleEl);

  const contentEl = targetDocument.createElement("div");
  contentEl.className = "prose-lumen";
  contentEl.id = "lumen-print-content";
  safeSetHtml(contentEl, printContent);

  safeClearHtml(body);
  body.appendChild(contentEl);
}

function printInlineFallback(
  safeDocName: string,
  themeClass: string,
  dir: string,
  safeStyles: string,
  printContent: string,
): void {
  const printRoot = document.createElement("div");
  printRoot.id = "lumen-inline-print-root";

  const styleEl = document.createElement("style");
  styleEl.id = "lumen-inline-print-fallback";
  styleEl.textContent = safeStyles + getInlinePrintStyleBlock();
  // The PDF's file name comes from the document title.
  const prevTitle = document.title;
  document.title = safeDocName;

  const contentEl = document.createElement("div");
  contentEl.className = "prose-lumen";
  contentEl.id = "lumen-print-content";
  safeSetHtml(contentEl, printContent);

  printRoot.setAttribute("class", themeClass);
  printRoot.setAttribute("dir", dir);
  printRoot.append(contentEl);
  document.head.appendChild(styleEl);
  document.body.appendChild(printRoot);

  const cleanup = () => {
    if (printRoot.parentNode) printRoot.remove();
    if (styleEl.parentNode) styleEl.remove();
    document.documentElement.removeAttribute("data-lumen-print-fallback");
    document.title = prevTitle;
    window.removeEventListener("afterprint", onAfterPrint);
  };

  const onAfterPrint = () => {
    cleanup();
  };

  window.addEventListener("afterprint", onAfterPrint, { once: true });
  document.documentElement.setAttribute("data-lumen-print-fallback", "true");

  // Print fallback in the current tab if popups are blocked by browser policy.
  setTimeout(() => {
    window.print();
    window.setTimeout(() => {
      cleanup();
    }, 3000);
  }, 120);
}

function getInlinePrintStyleBlock(): string {
  return `
  #lumen-inline-print-root {
    display: block;
    position: fixed;
    inset: 0;
    overflow: auto;
    background: white;
    z-index: 99999;
  }

  [data-lumen-print-fallback] #lumen-inline-print-root {
    width: 100%;
    min-height: 100%;
  }

  /* Only the print root: hiding every other element also hid the root's own
     content, so the fallback (popups blocked: installed apps, iOS) printed
     blank pages. */
  [data-lumen-print-fallback] body > :not(#lumen-inline-print-root) {
    display: none !important;
  }
  @media print {
    #lumen-inline-print-root { position: static; overflow: visible; }
  }`;
}
