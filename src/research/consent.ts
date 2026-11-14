/**
 * The one-time web-research consent (T34): the first research that would
 * reach the web asks once, and only the query (or a page address) is sent.
 * It covers `research.ask` only. Agent network tools (`search_web`,
 * `fetch_page`) ask for every call under the `local-only` policy (the
 * owner's decision, plan 15.10 (8)); a caller can supply its own prompt
 * through `RunOptions.consentNetwork`.
 */

const WEB_CONSENT_KEY = "lumen.research.webConsent";

export function hasWebConsent(): boolean {
  try {
    return localStorage.getItem(WEB_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function grantWebConsent(): void {
  try {
    localStorage.setItem(WEB_CONSENT_KEY, "1");
  } catch {
    /* why: asked again next time */
  }
}

export function revokeWebConsent(): void {
  try {
    localStorage.removeItem(WEB_CONSENT_KEY);
  } catch {
    /* why: nothing stored */
  }
}
