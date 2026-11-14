/**
 * Trusted Types integration.
 *
 * Production headers (security/policy.json → public/_headers, deploy/vercel.base.json,
 * the nginx configs) enforce
 *   require-trusted-types-for 'script';
 *   trusted-types lumen default dompurify lit-html iconify ProseMirrorClipboard 'allow-duplicates'
 * so every DOM XSS sink (innerHTML, srcdoc, DOMParser, Worker URLs, …)
 * rejects plain strings. This module provides two policies:
 *
 *  • `lumen` — used explicitly by our own code via `toTrustedHTML()`,
 *    `safeSetHtml()` and `parseInertDocument()`. Its `createHTML`
 *    SANITIZES with DOMPurify (html or svg profile). It is never an
 *    identity function, except for the `inert` kind, which is reachable
 *    only through `parseInertDocument()` (DOMParser output is an inert
 *    document; nothing executes).
 *
 *  • `default` — the browser invokes it automatically whenever a plain
 *    string reaches a sink. This is what lets third-party libraries
 *    (mermaid, tldraw, milkdown/prosemirror, model-viewer/lit, …) keep
 *    working under enforcement: their markup is sanitized with a broad
 *    html+svg+mathml DOMPurify profile instead of throwing. Script URLs are
 *    allowed only for same-origin (incl. same-origin `blob:`) URLs; string
 *    → script (`eval`, `new Function`) conversion is refused.
 *
 * Policy names created by third-party code are listed in
 * `TRUSTED_TYPES_POLICY_NAMES`; a unit test asserts the CSP headers allow
 * exactly those. `'allow-duplicates'` is needed because DOMPurify is
 * bundled more than once (ours + mermaid's copy) and each copy creates a
 * policy called `dompurify`.
 *
 * `installTrustedTypesPolicies()` must run before any library touches a
 * sink — it is called from the very first import in src/main.tsx.
 */

import DOMPurify from "dompurify";
import type { Config as DOMPurifyConfig } from "dompurify";
import { sanitizeHtmlMarkup, sanitizeSvgMarkup } from "./markupSanitizer";

/** Our explicit policy. */
export const LUMEN_POLICY_NAME = "lumen";

/**
 * Every policy name the app (or a bundled dependency) creates. Keep in
 * sync with the `trusted-types` directive of the app route in
 * security/policy.json — enforced by src/__tests__/csp.test.ts.
 *   lumen / default       — this module
 *   dompurify             — DOMPurify (ours + mermaid's bundled copy)
 *   lit-html              — @google/model-viewer → lit
 *   iconify               — mermaid → @iconify/utils
 *   ProseMirrorClipboard  — milkdown → prosemirror-view
 */
export const TRUSTED_TYPES_POLICY_NAMES = [
  LUMEN_POLICY_NAME,
  "default",
  "dompurify",
  "lit-html",
  "iconify",
  "ProseMirrorClipboard",
] as const;

export type HtmlKind = "html" | "svg";
/**
 * `inert`     — DOMParser input (inert document, nothing executes).
 * `sandboxed` — `srcdoc` of an iframe sandboxed WITHOUT allow-same-origin
 *               (opaque origin; cannot touch the app). Only reachable via
 *               `toTrustedSandboxedSrcdoc()`.
 */
type LumenKind = HtmlKind | "inert" | "sandboxed";

/** Minimal structural types — avoids depending on lib.dom's TT typings. */
interface PolicyOptions {
  createHTML?: (input: string, ...args: unknown[]) => string | null;
  createScript?: (input: string, ...args: unknown[]) => string | null;
  createScriptURL?: (input: string, ...args: unknown[]) => string | null;
}
interface Policy {
  createHTML(input: string, ...args: unknown[]): TrustedHTML;
}
export interface TrustedTypesFactory {
  createPolicy(name: string, options: PolicyOptions): Policy;
  readonly defaultPolicy?: unknown;
}

function getFactory(): TrustedTypesFactory | undefined {
  if (typeof globalThis === "undefined") return undefined;
  return (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
}

/* ─── Sanitizers ─────────────────────────────────────────────────── */

const PASS_THROUGH_KINDS: ReadonlySet<unknown> = new Set<LumenKind>(["inert", "sandboxed"]);

function sanitizeForLumen(input: string, kind: unknown): string {
  if (PASS_THROUGH_KINDS.has(kind)) return input;
  return kind === "svg" ? sanitizeSvgMarkup(input) : sanitizeHtmlMarkup(input);
}

/**
 * Broad profile for the default policy: third-party libraries emit SVG
 * (mermaid, tldraw icons), MathML and inline styles, so we keep those and
 * strip only active content.
 */
const DEFAULT_POLICY_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_TAGS: ["foreignObject"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "frame", "frameset"],
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

let defaultPurifier: ReturnType<typeof DOMPurify> | null = null;
let sanitizing = 0;

/**
 * Sanitize a string that hit a sink with no explicit policy. `sink` is the
 * sink name the browser passes (e.g. "Element innerHTML",
 * "HTMLIFrameElement srcdoc").
 */
export function sanitizeForDefaultPolicy(input: string, sink?: unknown): string {
  // Re-entrancy: if DOMPurify itself could not create its own policy, its
  // internal DOMParser call lands here. That parse produces an inert
  // document which DOMPurify is in the middle of sanitizing, so passing
  // it through is safe — and recursing would never terminate.
  if (sanitizing > 0) return input;
  if (typeof window === "undefined") return input;
  defaultPurifier ??= DOMPurify(window);
  sanitizing++;
  try {
    const wholeDocument = typeof sink === "string" && /srcdoc/i.test(sink);
    return String(
      defaultPurifier.sanitize(input, { ...DEFAULT_POLICY_CONFIG, WHOLE_DOCUMENT: wholeDocument }),
    );
  } finally {
    sanitizing--;
  }
}

/** Allow only same-origin script URLs (incl. same-origin `blob:` URLs). */
export function allowScriptUrl(input: string): string | null {
  if (typeof location === "undefined") return null;
  try {
    const url = new URL(input, location.href);
    if (url.origin === location.origin) return input;
  } catch {
    /* why: unparsable → reject */
  }
  return null;
}

/** See the `createScript` note in `installTrustedTypesPolicies`. */
export function passThroughScript(input: string): string {
  return input;
}

/* ─── Policy lifecycle ───────────────────────────────────────────── */

let lumenPolicy: Policy | null | undefined;
let defaultInstalled = false;

function getLumenPolicy(factory: TrustedTypesFactory | undefined = getFactory()): Policy | null {
  if (lumenPolicy !== undefined) return lumenPolicy;
  if (!factory) return (lumenPolicy = null);
  try {
    lumenPolicy = factory.createPolicy(LUMEN_POLICY_NAME, {
      createHTML: sanitizeForLumen,
    });
  } catch {
    // Name not allowed by CSP — fall back to the default policy path.
    lumenPolicy = null;
  }
  return lumenPolicy;
}

/**
 * Create the `lumen` and `default` policies. Idempotent; returns true when
 * Trusted Types are supported and the default policy is in place.
 */
export function installTrustedTypesPolicies(
  factory: TrustedTypesFactory | undefined = getFactory(),
): boolean {
  if (!factory) return false;
  getLumenPolicy(factory);
  if (defaultInstalled) return true;
  if (factory.defaultPolicy) return (defaultInstalled = true);
  try {
    factory.createPolicy("default", {
      createHTML: sanitizeForDefaultPolicy,
      createScriptURL: allowScriptUrl,
      // String → code (eval / new Function). The page CSP no longer allows
      // eval at all (F4: Graphviz moved into a worker with its own policy),
      // so this pass-through is never reached in production; it stays for
      // dev, where no CSP header is served. Trusted Types still guard every
      // HTML and script-URL sink above.
      createScript: passThroughScript,
    });
    defaultInstalled = true;
  } catch {
    defaultInstalled = false;
  }
  return defaultInstalled;
}

/** Test hook: forget cached policies so a new fake factory can be used. */
export function __resetTrustedTypesForTests(): void {
  lumenPolicy = undefined;
  defaultInstalled = false;
  defaultPurifier = null;
  sanitizing = 0;
}

/* ─── Public helpers ─────────────────────────────────────────────── */

/**
 * Sanitize `html` and return a value accepted by any HTML sink: a
 * TrustedHTML from the `lumen` policy when Trusted Types are available,
 * otherwise the sanitized string. Use for `dangerouslySetInnerHTML`.
 */
export function toTrustedHTML(html: string, kind: HtmlKind = "html"): string | TrustedHTML {
  const policy = getLumenPolicy();
  if (policy) return policy.createHTML(html, kind);
  return sanitizeForLumen(html, kind);
}

/** Sanitize and assign `innerHTML` through the `lumen` policy. */
export function safeSetHtml(el: Element, html: string, kind: HtmlKind = "html"): void {
  // lib.dom types innerHTML as `string`; the runtime sink accepts TrustedHTML.
  el.innerHTML = toTrustedHTML(html, kind) as string;
}

/** Remove all children without touching an HTML sink. */
export function safeClearHtml(el: Element): void {
  el.replaceChildren();
}

/**
 * `DOMParser.parseFromString` is a Trusted Types sink. The resulting
 * document is inert (no scripts run, nothing is attached to the page), so
 * our own parsers (DOCX/ODT/EPUB XML, HTML → Markdown import) pass the
 * text through unmodified via the `lumen` policy's `inert` kind.
 */
export function parseInertDocument(text: string, type: DOMParserSupportedType): Document {
  const policy = getLumenPolicy();
  const value = policy ? policy.createHTML(text, "inert") : text;
  return new DOMParser().parseFromString(value as string, type);
}

/**
 * Assign `srcdoc` on an iframe that is sandboxed WITHOUT `allow-same-origin`
 * (the document runs in an opaque origin and cannot reach the app), passing
 * the markup through unmodified. Throws if the iframe's sandbox would grant
 * same-origin access, so this can't be misused for a privileged frame.
 */
export function setSandboxedSrcdoc(iframe: HTMLIFrameElement, html: string): void {
  const sandbox = iframe.getAttribute("sandbox");
  if (sandbox === null || /\ballow-same-origin\b/i.test(sandbox)) {
    throw new Error("setSandboxedSrcdoc requires a sandboxed iframe without allow-same-origin");
  }
  const policy = getLumenPolicy();
  // lib.dom types srcdoc as `string`; the runtime sink accepts TrustedHTML.
  iframe.srcdoc = (policy ? policy.createHTML(html, "sandboxed") : html) as string;
}
