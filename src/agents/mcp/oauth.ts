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
 *   • Credentials are keyed by the issuer and never reused with another
 *     authorization server.
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

/** The authorization URL, and what to keep until the redirect comes back. */
export async function authorizationRequest(meta: AuthServerMetadata, redirectUri: string, scope?: string): Promise<{ url: string; pending: PendingAuthorization }> {
  if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes("S256")) throw new Error("the authorization server does not support PKCE S256");
  const verifier = randomToken(48);
  const state = randomToken(16);
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  if (scope) u.searchParams.set("scope", scope);
  return { url: u.toString(), pending: { issuer: meta.issuer, state, verifier, redirectUri } };
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
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** Credentials keyed by issuer: a server that moves to another authorization server needs a new sign-in. */
export class CredentialStore {
  private readonly byIssuer = new Map<string, StoredCredential>();
  set(c: StoredCredential): void {
    this.byIssuer.set(c.issuer, c);
  }
  get(issuer: string): StoredCredential | null {
    return this.byIssuer.get(issuer) ?? null;
  }
  /** The token for a server, only when the server still names the issuer it was issued by. */
  tokenFor(serverIssuer: string | undefined, currentIssuer: string): string | null {
    if (!serverIssuer || serverIssuer !== currentIssuer) return null;
    return this.byIssuer.get(currentIssuer)?.accessToken ?? null;
  }
}
