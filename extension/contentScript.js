/**
 * Lumen Web Clipper v2 — page side (plan 4.15).
 *
 * Collects what the app needs and nothing more: the page's HTML, the
 * selection as HTML, and the passages highlighted on this page. Extraction
 * (Defuddle, Readability fallback, Turndown) happens in Lumen itself, so the
 * clip looks the same whichever way it arrives.
 *
 * Highlighter (4.15.4): in highlight mode, each selection is marked on the
 * page and kept per URL in chrome.storage.local; the next clip of the page
 * carries them, and revisiting the page marks them again.
 */
(function () {
  if (window.__LUMEN_CLIP_V2__) return;
  window.__LUMEN_CLIP_V2__ = true;

  const pageKey = () => {
    const u = new URL(location.href);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(k)) u.searchParams.delete(k);
    return u.href;
  };
  const storeKey = () => `hl:${pageKey()}`;

  async function storedHighlights() {
    const r = await chrome.storage.local.get({ [storeKey()]: [] });
    return r[storeKey()] || [];
  }

  function mark(range) {
    try {
      const m = document.createElement("mark");
      m.className = "lumen-highlight";
      m.style.cssText = "background:#fde68a;color:inherit;padding:0 1px;border-radius:2px";
      m.appendChild(range.extractContents());
      range.insertNode(m);
    } catch {
      /* a range across blocks: kept in the list, not drawn */
    }
  }

  /** Find a stored highlight's text in the page again and mark it. */
  function remark(text) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(text);
      if (i >= 0 && !n.parentElement?.closest("mark.lumen-highlight")) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + text.length);
        mark(r);
        return;
      }
    }
  }

  let highlighting = false;
  async function onMouseUp() {
    if (!highlighting) return;
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, " ").trim();
    if (!sel || !text || text.length < 3) return;
    const list = await storedHighlights();
    if (!list.includes(text)) list.push(text);
    await chrome.storage.local.set({ [storeKey()]: list });
    mark(sel.getRangeAt(0));
    sel.removeAllRanges();
  }
  document.addEventListener("mouseup", onMouseUp);
  void storedHighlights().then((l) => l.forEach(remark));

  function selectionHtml() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length < 20) return undefined;
    const div = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) div.appendChild(sel.getRangeAt(i).cloneContents());
    return div.innerHTML;
  }

  async function clip(opts = {}) {
    const payload = {
      url: location.href,
      html: opts.selectionOnly ? undefined : document.documentElement.outerHTML,
      selectionHtml: selectionHtml(),
      highlights: await storedHighlights(),
    };
    if (!payload.html && !payload.selectionHtml) return flashBadge("Select some text first", true);
    chrome.runtime.sendMessage({ type: "lumen-clip", payload }, (resp) => {
      flashBadge(resp?.ok ? "Sent to Lumen ✓" : "Couldn't reach Lumen", !resp?.ok);
    });
  }

  function flashBadge(message, error = false) {
    const el = document.createElement("div");
    el.textContent = message;
    el.style.cssText = `position:fixed;bottom:22px;right:22px;z-index:2147483647;padding:10px 16px;border-radius:999px;font:500 13px system-ui;color:#fff;background:${error ? "#dc2626" : "#5b45d6"};box-shadow:0 8px 24px -4px rgba(0,0,0,.3)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "lumen-clip-page") void clip(msg);
    if (msg?.type === "lumen-highlight-mode") {
      highlighting = !highlighting;
      flashBadge(highlighting ? "Highlighter on — select text to highlight" : "Highlighter off");
    }
  });
})();
