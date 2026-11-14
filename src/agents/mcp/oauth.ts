/**
 * OAuth for remote MCP servers (plan W7.18), per the 2026-07-28 spec:
 *
 *   • Client registration by a Client ID Metadata Document: our client_id
 *     is the URL of public/oauth/client-metadata.json (dynamic client
 *     registration is deprecated in 2026-07-28).
 *   • PKCE (S256) and `state` on every authorization request.
 *   • RFC 9207: a present `iss` in the authorization response MUST equal
 *     the issuer we recorded before the code is redeemed; when the server's
 *     metadata says it sends `iss`, a response without it is refused.
 *   • RFC 8707: every request names the MCP server it is for (`resource`),
 *     so a token is bound to that server; credentials are keyed by
 *     (issuer, resource) and never handed to another server, even one that
 *     uses the same authorization server (review 21, C4).
 *   • The authorization server's metadata must advertise PKCE S256 (the MCP
 *     authorization spec), and its issuer must be the origin it was fetched
 *     from (RFC 8414 §3.3).
 */
export const CLIENT_ID = "https://lumen-md.vercel.app/oauth/client-metadata.json";

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  authorization_response_iss_parameter_supported?: boolean;
  client_id_metadata_document_supported?: boolean;
  code_challenge_methods_supported?: string[];
}

export interface PendingAuthorization {
  issuer: string;
  state: string;
  verifier: string;
  redirectUri: string;
  /** The MCP server the token is for (sent again as `resource` with the code). */
  resource: string;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Refuse metadata that does not advertise S256 or whose issuer is not where it was fetched (RFC 8414 §3.3). */
export function checkAuthServerMetadata(meta: AuthServerMetadata, expectedIssuer: string): void {
  if (!meta.code_challenge_methods_supported?.includes("S256")) throw new Error("the authorization server does not advertise PKCE S256: refused");
  if (meta.issuer !== expectedIssuer) throw new Error(`the authorization server's metadata names ${meta.issuer}, not ${expectedIssuer}: refused`);
}

/** The canonical URI of an MCP server, for `resource` (RFC 8707): scheme and host lower-case, no fragment. */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/** The authorization URL, and what to keep until the redirect comes back. `resource`: the MCP server's URL. */
export async function authorizationRequest(meta: AuthServerMetadata, redirectUri: string, opts: { resource: string; scope?: string }): Promise<{ url: string; pending: PendingAuthorization }> {
  if (!meta.code_challenge_methods_supported?.includes("S256")) throw new Error("the authorization server does not advertise PKCE S256: refused");
  if (!opts?.resource) throw new Error("an authorization request must name the MCP server it is for (resource, RFC 8707)");
  const resource = canonicalResource(opts.resource);
  const verifier = randomToken(48);
  const state = randomToken(16);
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", resource);
  if (opts.scope) u.searchParams.set("scope", opts.scope);
  return { url: u.toString(), pending: { issuer: meta.issuer, state, verifier, redirectUri, resource } };
}

/** Check the redirect's parameters before redeeming the code (state, RFC 9207 `iss`). Returns the code. */
export function checkAuthorizationResponse(params: URLSearchParams, pending: PendingAuthorization, meta: Pick<AuthServerMetadata, "authorization_response_iss_parameter_supported">): string {
  if (params.get("error")) throw new Error(`authorization refused: ${params.get("error")}`);
  if (params.get("state") !== pending.state) throw new Error("the authorization response does not belong to this request (state)");
  const iss = params.get("iss");
  if (iss !== null && iss !== pending.issuer) throw new Error(`the authorization response came from ${iss}, not ${pending.issuer} (RFC 9207)`);
  if (iss === null && meta.authorization_response_iss_parameter_supported) throw new Error("the authorization server sends iss, but this response has none (RFC 9207)");
  const code = params.get("code");
  if (!code) throw new Error("the authorization response has no code");
  return code;
}

export interface StoredCredential {
  issuer: string;
  /** The MCP server the token was issued for (RFC 8707). */
  resource: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** Credentials keyed by (issuer, resource): a token for one server never goes to another. */
export class CredentialStore {
  private readonly byKey = new Map<string, StoredCredential>();
  private key(issuer: string, resource: string): string {
    return JSON.stringify([issuer, canonicalResource(resource)]);
  }
  set(c: StoredCredential): void {
    if (!c.resource) throw new Error("a credential must name its resource");
    this.byKey.set(this.key(c.issuer, c.resource), c);
  }
  get(issuer: string, resource: string): StoredCredential | null {
    try {
      return this.byKey.get(this.key(issuer, resource)) ?? null;
    } catch {
      return null;
    }
  }
  /** The token for this server from this issuer, or null (another server, another issuer, or none). */
  tokenFor(issuer: string, resource: string): string | null {
    return this.get(issuer, resource)?.accessToken ?? null;
  }
}
