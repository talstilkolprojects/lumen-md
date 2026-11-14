/**
 * Sanitizer for raw HTML inside Markdown (T48). Runs right after rehype-raw,
 * only in the pipeline for documents that contain inline HTML.
 *
 * Elements: anything that can run script, navigate the app, load plugins or
 * restyle the whole app (script, iframe srcdoc, object, embed, form, meta,
 * base, link, style, …) is removed with its content.
 * Attributes: event handlers (on*), srcdoc, formaction and friends are
 * dropped; URL attributes keep only http(s), mailto, tel, relative and
 * #fragment links (and data:image/* for images) — no javascript:, vbscript:
 * or data:text/html.
 * Iframes (embeds written as HTML) keep an https src and always get a
 * sandbox without same-origin powers over the app.
 * Other-site loads (plan 2.2): <img> stays and is held back by the
 * preview's placeholder (src/lib/remoteImages.ts). Everything else that
 * would fetch from another site on its own is removed here: <source srcset>
 * (a <picture> falls back to its <img>), video posters, the legacy
 * `background` attribute and SVG `href`s. <video> / <audio> lose autoplay,
 * get preload="none", and keep at most one other-site URL (their own src),
 * which the preview holds back like an image.
 */
import { visit, SKIP } from "unist-util-visit";
import type { Element, Root, Parent } from "hast";
import { remoteImageHost, srcSetUrls } from "../lib/remoteImages";

const DROP_ELEMENTS = new Set([
  "script", "style", "noscript", "template", "object", "embed", "applet",
  "form", "button", "select", "textarea", "option",
  "meta", "base", "link", "frame", "frameset", "portal", "fencedframe", "param",
]);

const DROP_PROPS = new Set(["srcDoc", "formAction", "formMethod", "formTarget", "ping", "httpEquiv", "is"]);

const URL_PROPS = new Set(["href", "src", "xLinkHref", "action", "poster", "cite", "background", "data", "longDesc", "useMap", "manifest", "codeBase"]);

const SAFE_SCHEME = /^(?:https?:|mailto:|tel:)/i;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);/i;

/** Is this URL safe for the given element/property? Exported for tests. */
export function safeUrl(value: string, tag: string, prop: string): boolean {
  // Browsers ignore ASCII whitespace and control characters inside a
  // scheme ("java\tscript:"), so compare without them.
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000- \u007f]+/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  // Relative, #fragment, /path, ./file.md — fine for links and images, but an
  // iframe with a scheme-less src would load the app's own origin with
  // allow-same-origin, so frames need an explicit https: URL.
  if (!scheme) return tag !== "iframe";
  if (SAFE_SCHEME.test(v)) return tag === "iframe" ? /^https:/i.test(v) : true;
  if (DATA_IMAGE.test(v) && (tag === "img" || tag === "source" || tag === "picture") && (prop === "src" || prop === "srcSet")) return true;
  return false;
}

/**
 * Classes the Markdown pipeline itself emits before this pass (GFM task lists
 * and footnotes, math, fenced-code languages, admonitions, columns, wiki
 * links, `![[embeds]]`). Any other class on raw HTML could only borrow host-app styling —
 * e.g. `class="lumen-slash-menu"` or Tailwind's `fixed` restores
 * `position: fixed; z-index: 9999` and lets a note cover the app — so it is
 * dropped. Exported for tests.
 */
const PIPELINE_CLASSES = new Set([
  "contains-task-list", "task-list-item", "footnotes", "sr-only", "data-footnote-backref",
  "math-inline", "math-display",
  "admonition", "admonition-title", "note", "tip", "info", "warning", "danger",
  "lumen-columns", "lumen-column", "wiki-link",
  "lumen-embed", "lumen-embed-title", "lumen-embed-body", "lumen-embed-notice", "lumen-embed-image",
]);
export function safeClass(token: string): boolean {
  return PIPELINE_CLASSES.has(token) || /^language-[\w+#.-]+$/.test(token);
}

function cleanSrcSet(value: string, tag: string): string | null {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const ok = parts.filter((p) => safeUrl(p.split(/\s+/)[0] ?? "", tag, "srcSet"));
  return ok.length ? ok.join(", ") : null;
}

/** Links navigate only when clicked; on any other element an href loads. */
const LINK_TAGS = new Set(["a", "area"]);

/** Remove the other-site loads that no placeholder guards (see header). */
function dropRemoteLoads(el: Element, props: NonNullable<Element["properties"]>) {
  const remote = (v: unknown) => remoteImageHost(Array.isArray(v) ? v.join(" ") : String(v ?? "")) !== null;
  if (el.tagName === "source" && typeof props.srcSet === "string" && srcSetUrls(props.srcSet).some((u) => remoteImageHost(u))) delete props.srcSet;
  for (const key of ["poster", "background"]) if (key in props && remote(props[key])) delete props[key];
  if (!LINK_TAGS.has(el.tagName)) for (const key of ["href", "xLinkHref"]) if (key in props && remote(props[key])) delete props[key];
  if (el.tagName === "video" || el.tagName === "audio") {
    delete props.autoPlay;
    props.preload = "none";
    // The preview gates other-site media on the element's own src, like an
    // <img> (WebKit fetches a video src despite preload="none"). Hoist the
    // first other-site <source src> to it and drop other-site <source> /
    // <track> children, so that one src is all a load can come from.
    const kids = el.children ?? [];
    const remoteKid = (k: (typeof kids)[number]): k is Element =>
      k.type === "element" && (k.tagName === "source" || k.tagName === "track") && remote(k.properties?.src);
    const first = kids.find((k): k is Element => remoteKid(k) && k.tagName === "source");
    if (first && !props.src) props.src = String(first.properties!.src);
    el.children = kids.filter((k) => !remoteKid(k));
  }
}

function cleanElement(el: Element) {
  const props = el.properties ?? {};
  // GFM task lists render as disabled checkboxes; no other input survives.
  if (el.tagName === "input") {
    if (props.type !== "checkbox") return false;
    props.disabled = true;
  }
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (/^on/i.test(key) || DROP_PROPS.has(key)) {
      delete props[key];
      continue;
    }
    if (URL_PROPS.has(key)) {
      const s = Array.isArray(value) ? value.join(" ") : String(value ?? "");
      if (!safeUrl(s, el.tagName, key)) delete props[key];
      continue;
    }
    if (key === "className") {
      const list = Array.isArray(value) ? value.map(String) : String(value ?? "").split(/\s+/);
      const kept = list.filter((c) => c && safeClass(c));
      if (kept.length) props[key] = kept;
      else delete props[key];
      continue;
    }
    if (key === "srcSet") {
      const s = Array.isArray(value) ? value.join(", ") : String(value ?? "");
      const cleaned = cleanSrcSet(s, el.tagName);
      if (cleaned) props[key] = cleaned;
      else delete props[key];
      continue;
    }
    if (key === "style" && typeof value === "string") {
      // No remote loads or legacy script hooks through inline CSS.
      if (/url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding/i.test(value)) delete props[key];
      // Don't let a note cover the app (fake dialogs, click-jacking).
      else if (/position\s*:\s*(fixed|sticky)/i.test(value)) props[key] = value.replace(/position\s*:\s*(fixed|sticky)/gi, "position: static");
    }
  }
  if (el.tagName === "a" && typeof props.target === "string" && props.target !== "_self") {
    props.rel = ["noopener", "noreferrer"];
  }
  dropRemoteLoads(el, props);
  if (el.tagName === "iframe") {
    if (typeof props.src !== "string") return false;
    props.sandbox = ["allow-scripts", "allow-popups", "allow-presentation", "allow-same-origin"];
    props.referrerPolicy = "no-referrer";
    props.loading = "lazy";
  }
  el.properties = props;
  return true;
}

export function rehypeSanitizeRaw() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent: Parent | undefined) => {
      const drop = DROP_ELEMENTS.has(node.tagName) || !cleanElement(node);
      if (drop && parent && typeof index === "number") {
        parent.children.splice(index, 1);
        return [SKIP, index];
      }
      return undefined;
    });
    // Raw HTML comments are harmless, but conditional comments and stray
    // doctype/raw nodes have no business in the preview.
    visit(tree, (node, index, parent: Parent | undefined) => {
      if ((node.type === "raw" || node.type === "doctype") && parent && typeof index === "number") {
        parent.children.splice(index, 1);
        return [SKIP, index];
      }
      return undefined;
    });
  };
}
