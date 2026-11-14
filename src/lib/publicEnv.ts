/**
 * Build-time public configuration (`VITE_*`), read one name at a time.
 *
 * Vite replaces `import.meta.env.VITE_X` with that one value, but any read
 * of `import.meta.env` as a whole object (`const env = import.meta.env;
 * env[key]`) makes it inline EVERY `VITE_*` variable of the build into the
 * chunk. Readers that pick a name at runtime go through this switch of
 * static reads instead, so only the names listed here can reach the bundle.
 *
 * Everything here is public by design. Secrets never come from `VITE_*`
 * (enforced by scripts/check-code-hygiene.mjs and, on the built app, by
 * scripts/check-vite-secrets.mjs): a user-entered secret goes in the
 * secret store (src/lib/secretStore.ts).
 */

export type PublicEnvName =
  | "VITE_BILLING_ENDPOINT"
  | "VITE_ENTITLEMENT_ENDPOINT"
  | "VITE_PRICE_ID_PRO"
  | "VITE_PRICE_ID_TEAM"
  | "VITE_PUBLISH_ENDPOINT"
  | "VITE_PUBLISH_MOCK_ENABLED"
  | "VITE_WEBRTC_SIGNALING_URL"
  | "VITE_DROPBOX_APP_KEY"
  | "VITE_GDRIVE_CLIENT_ID"
  | "VITE_SENTRY_DSN"
  | "VITE_DOCS_URL"
  | "VITE_PLUGIN_TRUSTED_KEYS";

function raw(name: PublicEnvName): string | undefined {
  // Static reads only: no `import.meta.env` without a property after it.
  switch (name) {
    case "VITE_BILLING_ENDPOINT":
      return import.meta.env.VITE_BILLING_ENDPOINT;
    case "VITE_ENTITLEMENT_ENDPOINT":
      return import.meta.env.VITE_ENTITLEMENT_ENDPOINT;
    case "VITE_PRICE_ID_PRO":
      return import.meta.env.VITE_PRICE_ID_PRO;
    case "VITE_PRICE_ID_TEAM":
      return import.meta.env.VITE_PRICE_ID_TEAM;
    case "VITE_PUBLISH_ENDPOINT":
      return import.meta.env.VITE_PUBLISH_ENDPOINT;
    case "VITE_PUBLISH_MOCK_ENABLED":
      return import.meta.env.VITE_PUBLISH_MOCK_ENABLED;
    case "VITE_WEBRTC_SIGNALING_URL":
      return import.meta.env.VITE_WEBRTC_SIGNALING_URL;
    case "VITE_DROPBOX_APP_KEY":
      return import.meta.env.VITE_DROPBOX_APP_KEY;
    case "VITE_GDRIVE_CLIENT_ID":
      return import.meta.env.VITE_GDRIVE_CLIENT_ID;
    case "VITE_SENTRY_DSN":
      return import.meta.env.VITE_SENTRY_DSN;
    case "VITE_DOCS_URL":
      return import.meta.env.VITE_DOCS_URL;
    case "VITE_PLUGIN_TRUSTED_KEYS":
      return import.meta.env.VITE_PLUGIN_TRUSTED_KEYS;
  }
}

/** The trimmed value of a public build variable, "" when unset. */
export function publicEnv(name: PublicEnvName): string {
  try {
    const v = raw(name);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}
