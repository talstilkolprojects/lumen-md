/**
 * "Learn more" documentation links for user-facing errors
 * (PRODUCT_IMPROVEMENT_MASTER_PLAN 2.4).
 *
 * Every topic maps to a page that exists under `docs/src/content/docs/`
 * — `docsLinks.test.ts` enforces that, so a renamed page can't silently
 * turn a CTA into a 404. Self-hosters can point the links at their own
 * copy of the docs site with `VITE_DOCS_URL`.
 */

import { publicEnv } from "./publicEnv";

const DEFAULT_DOCS_BASE = "https://docs.lumen.app";

/** Topic → docs slug (path under the docs site, no leading slash). */
export const DOCS_TOPICS = {
  signIn: "account/sign-in",
  sso: "account/sso",
  organization: "account/organization",
  pluginSigning: "plugins/signing",
  localLlm: "ai/local-llm",
  localAgents: "ai/local-agents",
  a11yStatement: "editor/accessibility-statement",
  trustedRepos: "security/trusted-repos",
  acr: "editor/acr",
} as const;

export type DocsTopic = keyof typeof DOCS_TOPICS;

function readDocsBase(): string {
  try {
    const raw = publicEnv("VITE_DOCS_URL");
    if (raw && /^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  } catch {
    /* why: no env in this runtime */
  }
  return DEFAULT_DOCS_BASE;
}

/** Absolute URL of a docs topic, optionally with an in-page anchor; `he` for the Hebrew page. */
export function docsUrl(topic: DocsTopic, anchor?: string, locale?: "he"): string {
  const url = `${readDocsBase()}/${locale ? `${locale}/` : ""}${DOCS_TOPICS[topic]}/`;
  return anchor ? `${url}#${anchor}` : url;
}

/** The docs site's base URL (VITE_DOCS_URL, else the default). */
export const docsBaseUrl = (): string => readDocsBase();
