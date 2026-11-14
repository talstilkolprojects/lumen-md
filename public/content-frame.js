/*
 * Content frame (plan W4.15) — public/content-frame.html's only script.
 *
 * The app frames this page to show what another site serves into a note,
 * once the user allowed it (src/lib/contentFrame.ts builds the request):
 *
 *   #{"kind":"img","src":"https://…","srcset":"…","alt":"…","title":"…"}
 *   #{"kind":"video"|"audio","src":"https://…","loop":true,"muted":true}
 *   #{"kind":"embed","src":"https://provider/…","title":"…","allow":"…","referrerPolicy":"…"}
 *
 * The request travels in the #fragment, which is never sent to a server and
 * is not part of the service worker's cache key. Everything is built with
 * createElement and properties — no HTML sink — and the page has no network
 * of its own (connect-src 'none'); its policy allows https: images and media
 * and the embed providers' frames, which the app's own policy does not.
 * A Gist is not shown here (W10.D2): the app shows a link.
 *
 * The page tells its parent the size its content wants:
 *   parent.postMessage({ type: "lumen-content-frame", width, height }, origin)
 * (the parent matches event.source to the frame; frame-ancestors 'self'
 * makes the app the only parent).

 */
(function () {
  "use strict";
  var TYPE = "lumen-content-frame";
  var origin = location.origin;
  var body = document.body;

  function post(width, height) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: TYPE, width: Math.round(width), height: Math.ceil(height) }, origin);
  }

  function httpsUrl(value) {
    if (typeof value !== "string") return null;
    try {
      var url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  function text(value) {
    return typeof value === "string" ? value.slice(0, 500) : "";
  }

  /** Content failed (or the request was not one this page shows): its words instead. */
  function fallback(label) {
    body.className = "";
    var p = document.createElement("p");
    p.style.cssText = "margin:0;padding:4px 6px;font:13px system-ui,sans-serif;color:#888;";
    p.dir = "auto";
    p.textContent = label || "⚠";
    body.replaceChildren(p);
    post(p.scrollWidth, p.scrollHeight);
  }

  function watchHeight(el) {
    var report = function () {
      post(document.documentElement.scrollWidth, el.getBoundingClientRect().height || document.documentElement.scrollHeight);
    };
    if (typeof ResizeObserver === "function") new ResizeObserver(report).observe(el);
    report();
  }

  var req = null;
  try {
    req = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  } catch (e) {
    req = null;
  }
  if (!req || typeof req !== "object") return fallback("");
  var opaque = self.origin === "null";

  if (req.kind === "img") {
    var src = httpsUrl(req.src);
    if (!src) return fallback(text(req.alt));
    var img = document.createElement("img");
    img.alt = text(req.alt);
    if (req.title) img.title = text(req.title);
    if (typeof req.srcset === "string") {
      var kept = req.srcset
        .split(",")
        .map(function (p) { return p.trim(); })
        .filter(function (p) { return p && httpsUrl(p.split(/\s+/)[0]); });
      if (kept.length) img.srcset = kept.join(", ");
    }
    img.decoding = "async";
    img.addEventListener("load", function () { post(img.naturalWidth, img.naturalHeight); });
    img.addEventListener("error", function () { fallback(img.alt); });
    img.src = src;
    body.className = "lumen-cf-fill";
    body.appendChild(img);
    return;
  }

  if (req.kind === "video" || req.kind === "audio") {
    var msrc = httpsUrl(req.src);
    if (!msrc) return fallback(text(req.title));
    var media = document.createElement(req.kind);
    media.controls = true;
    media.preload = "metadata";
    if (req.loop === true) media.loop = true;
    if (req.muted === true) media.muted = true;
    if (req.kind === "video") media.playsInline = true;
    if (req.title) media.title = text(req.title);
    media.addEventListener("error", function () { fallback(text(req.title) || msrc); });
    if (req.kind === "video") {
      media.addEventListener("loadedmetadata", function () {
        if (media.videoWidth && media.videoHeight) post(media.videoWidth, media.videoHeight);
      });
      body.className = "lumen-cf-fill";
    }
    media.src = msrc;
    body.appendChild(media);
    if (req.kind === "audio") watchHeight(media);
    return;
  }

  if (req.kind === "embed") {
    var esrc = httpsUrl(req.src);
    if (!esrc) return fallback(text(req.title));
    var frame = document.createElement("iframe");
    frame.title = text(req.title);
    if (typeof req.allow === "string") frame.allow = req.allow;
    frame.allowFullscreen = true;
    var policies = ["no-referrer", "strict-origin-when-cross-origin", "strict-origin", "origin"];
    frame.referrerPolicy = policies.indexOf(req.referrerPolicy) >= 0 ? req.referrerPolicy : "strict-origin-when-cross-origin";
    // The flags the embed block always gave the provider's frame. A frame
    // never gets more than this page has, and the app frames this page with
    // the same set for embeds.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation allow-forms");
    frame.src = esrc;
    body.className = "lumen-cf-fill";
    body.appendChild(frame);
    return;
  }

  // W10.D2: a Gist is not shown here any more. Its embed is GitHub's script
  // document.write()ing into this page; the app shows a link instead, so no
  // third-party script runs in a page of ours. An old request gets its words.
  if (req.kind === "gist") return fallback("gist.github.com");

  fallback("");
})();
