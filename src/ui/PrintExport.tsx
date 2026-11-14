/**
 * Print / Export to PDF utility.
 *
 * Renders the markdown preview in a new window with all styles preserved,
 * then triggers window.print() which on modern browsers offers "Save as PDF".
 */

import { renderMarkdown } from "../renderer/pipeline";
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
  const isDark = () => document.documentElement.classList.contains("dark");
  // W5.11: the PDF gets the text without its marked passages (removed, not
  // covered), and photos inlined without metadata (Chromium embeds a JPEG as is).
  const tree = await renderMarkdown(await exportReadyText(markdownText, true), isDark);

  // We need to serialize the React tree. We'll render to a temporary div.
  const { createRoot } = await import("react-dom/client");
  const { createElement, Fragment } = await import("react");

  const temp = document.createElement("div");
  const root = createRoot(temp);

  await new Promise<void>((resolve) => {
    root.render(
      createElement(Fragment, null, tree),
    );
    // Give React a tick to flush
    setTimeout(resolve, 100);
  });

  const htmlContent = temp.innerHTML;
  root.unmount();

  // Gather all stylesheets from the current document
  const styles: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      const rules = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      styles.push(rules);
    } catch {
      // why: Cross-origin sheets — skip
    }
  }

  // Get current theme class
  const themeClass = document.documentElement.classList.contains("dark")
    ? "dark"
    : "";
  const dir = document.documentElement.dir || "ltr";

  const safeDocName = docName || "Untitled";
  const safeStyles = styles.join("\n\n");
  // Sanitized at the sink by the `lumen` Trusted Types policy (safeSetHtml).
  const printContent = htmlContent;

  const printWindow = window.open("", "_blank");
  if (printWindow?.document) {
    hydratePrintDocument(
      printWindow.document,
      safeDocName,
      themeClass,
      dir,
      safeStyles,
      printContent,
    );
    setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 120);
    return;
  }

  printInlineFallback(
    safeDocName,
    themeClass,
    dir,
    safeStyles,
    printContent,
  );
}

function hydratePrintDocument(
  targetDocument: Document,
  safeDocName: string,
  themeClass: string,
  dir: string,
  safeStyles: string,
  printContent: string,
): void {
  targetDocument.open();
  targetDocument.close();

  const htmlElement = targetDocument.documentElement;
  if (!htmlElement) return;

  htmlElement.className = themeClass;
  htmlElement.setAttribute("dir", dir);
  htmlElement.setAttribute("lang", "en");
  targetDocument.title = `${safeDocName} — Lumen`;

  const head = targetDocument.head;
  const body = targetDocument.body;
  if (!head || !body) return;

  const styleEl = targetDocument.createElement("style");
  styleEl.textContent = getPrintStyleBlock(safeStyles);
  head.appendChild(styleEl);

  const headerEl = targetDocument.createElement("div");
  headerEl.className = "print-header";
  headerEl.id = "lumen-print-title";
  headerEl.textContent = `${safeDocName} — Exported from Lumen`;

  const contentEl = targetDocument.createElement("div");
  contentEl.className = "prose-lumen";
  contentEl.id = "lumen-print-content";
  safeSetHtml(contentEl, printContent);

  safeClearHtml(body);
  body.appendChild(headerEl);
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
  styleEl.textContent = getPrintStyleBlock(safeStyles) + getInlinePrintStyleBlock();

  const headerEl = document.createElement("div");
  headerEl.className = "print-header";
  headerEl.id = "lumen-print-title";
  headerEl.textContent = `${safeDocName} — Exported from Lumen`;

  const contentEl = document.createElement("div");
  contentEl.className = "prose-lumen";
  contentEl.id = "lumen-print-content";
  safeSetHtml(contentEl, printContent);

  printRoot.setAttribute("class", themeClass);
  printRoot.setAttribute("dir", dir);
  printRoot.append(headerEl, contentEl);
  document.head.appendChild(styleEl);
  document.body.appendChild(printRoot);

  const cleanup = () => {
    if (printRoot.parentNode) printRoot.remove();
    if (styleEl.parentNode) styleEl.remove();
    document.documentElement.removeAttribute("data-lumen-print-fallback");
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

function getPrintStyleBlock(safeStyles: string): string {
  return `${safeStyles}

  /* Print overrides */
  @media print {
    body {
      margin: 0;
      padding: 20mm;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    .prose-lumen {
      max-width: none;
      padding: 0;
    }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
  }

  @media screen {
    body {
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
  }

  .print-header {
    text-align: center;
    padding-bottom: 16px;
    margin-bottom: 24px;
    border-bottom: 2px solid hsl(var(--border, 220 10% 30%));
    font-size: 11px;
    color: hsl(var(--fg-muted, 220 10% 60%));
  }`;
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

  [data-lumen-print-fallback] :not(#lumen-inline-print-root) {
    display: none !important;
  }`;
}
