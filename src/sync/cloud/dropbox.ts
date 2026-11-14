/**
 * Dropbox — OAuth (PKCE, no client secret in the browser) and the plain-text
 * side the migration to encrypted sync reads from (plan 3.5). The encrypted
 * `SyncProvider` over Dropbox is src/sync/e2ee/providers/dropbox.ts; it uses
 * `dropboxFetch` from here.
 *
 * Configuration: `VITE_DROPBOX_APP_KEY` — the app key (a public identifier,
 * not a secret; plan 15.5). Without it the OAuth flow is unavailable and
 * `dropboxConfigured()` is false. Tokens live in the secret store.
 */

import { fetchWithRetry } from "../../lib/fetchRetry";
import type { CloudFile, LegacyCloudStore } from "./types";
import { getSecret, setSecret } from "../../lib/secretStore";

const TOKEN_KEY = "lumen.cloud.dropbox.token";
const REFRESH_KEY = "lumen.cloud.dropbox.refresh";
/** Where an earlier Lumen synced plain-text notes (App folder permission). */
export const DROPBOX_LEGACY_FOLDER = "/Apps/Lumen";
/** The encrypted vault's folder inside the legacy one (`DROPBOX_DEFAULT_FOLDER` = "/Apps/Lumen/vault"). */
const LEGACY_VAULT_SUBFOLDER = "vault";
const PKCE_KEY = "lumen.cloud.dropbox.pkce";

interface TokenSet {
  access: string;
  refresh?: string;
  expiresAt: number;
}

/** Is the OAuth client configured? (plan 15.5) */
export function dropboxConfigured(): boolean {
  return !!appKey();
}

function appKey(): string {
  return (
    (import.meta as ImportMeta & { env?: { VITE_DROPBOX_APP_KEY?: string } })
      .env?.VITE_DROPBOX_APP_KEY ?? ""
  );
}

function redirectUri(): string {
  const env = (
    import.meta as ImportMeta & { env?: { VITE_DROPBOX_REDIRECT?: string } }
  ).env?.VITE_DROPBOX_REDIRECT;
  if (env) return env;
  return `${location.origin}/oauth/dropbox`;
}

function loadToken(): TokenSet | null {
  try {
    const raw = getSecret(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : null;
  } catch {
    return null;
  }
}

function saveToken(tok: TokenSet): void {
  setSecret(TOKEN_KEY, JSON.stringify(tok));
  if (tok.refresh) setSecret(REFRESH_KEY, tok.refresh);
}

function clearToken(): void {
  setSecret(TOKEN_KEY, null);
  setSecret(REFRESH_KEY, null);
  localStorage.removeItem(PKCE_KEY);
}

/* ─── PKCE helpers ───────────────────────────────────────────────────── */

async function sha256Base64Url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len = 64): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, len);
}

/* ─── Token plumbing ─────────────────────────────────────────────────── */

async function refreshAccessToken(): Promise<string> {
  const refresh = getSecret(REFRESH_KEY);
  if (!refresh) throw new Error("Dropbox is disconnected — sign in again.");
  const res = await fetchWithRetry("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: appKey(),
    }),
  }, { label: "dropbox.refreshToken", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 4000 });
  if (!res.ok) {
    clearToken();
    throw new Error(`Dropbox refresh failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const tok: TokenSet = {
    access: json.access_token,
    refresh,
    expiresAt: Date.now() + json.expires_in * 1000 - 30_000,
  };
  saveToken(tok);
  return tok.access;
}

async function getAccessToken(): Promise<string> {
  const tok = loadToken();
  if (tok && tok.expiresAt > Date.now()) return tok.access;
  return refreshAccessToken();
}

/**
 * An authenticated request to Dropbox: `path` on the RPC endpoint, or on the
 * content endpoint with `contentEndpoint`. Returns the raw response (callers
 * read status and headers themselves — the encrypted provider needs 409
 * bodies and `Dropbox-API-Result`).
 */
export async function dropboxFetch(
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string>; contentEndpoint?: boolean } = {},
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (i, o) => fetch(i, o),
): Promise<Response> {
  const access = await getAccessToken();
  const url = (init.contentEndpoint ? "https://content.dropboxapi.com" : "https://api.dropboxapi.com") + path;
  const headers: Record<string, string> = { Authorization: `Bearer ${access}`, ...(init.headers ?? {}) };
  if (!init.contentEndpoint && !("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  return fetchImpl(url, { method: "POST", headers, body: init.body });
}

async function rpc<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(
    "https://api.dropboxapi.com" + path,
    { method: "POST", headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { label: "dropbox.rpc", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 2500 },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/* ─── The plain-text side (migration reads it) ───────────────────────── */

export const dropboxLegacy: LegacyCloudStore = {
  name: "dropbox",
  isConnected(): boolean {
    return !!getSecret(TOKEN_KEY);
  },
  async connect(): Promise<void> {
    if (!appKey()) {
      throw new Error("VITE_DROPBOX_APP_KEY is not set — see .env.example.");
    }
    const verifier = randomString(64);
    const challenge = await sha256Base64Url(verifier);
    localStorage.setItem(PKCE_KEY, verifier);
    const url = new URL("https://www.dropbox.com/oauth2/authorize");
    url.searchParams.set("client_id", appKey());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("token_access_type", "offline");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    location.assign(url.toString());
  },
  async disconnect(): Promise<void> {
    clearToken();
  },
  async listFiles(): Promise<CloudFile[]> {
    type Entry = {
      [".tag"]: "file" | "folder";
      path_lower: string;
      path_display?: string;
      size?: number;
      server_modified?: string;
      content_hash?: string;
    };
    const out: CloudFile[] = [];
    let cursor: string | undefined;
    do {
      const body = cursor ? { cursor } : { path: DROPBOX_LEGACY_FOLDER, recursive: true, include_non_downloadable_files: false };
      let res: { entries: Entry[]; cursor?: string; has_more: boolean };
      try {
        res = await rpc(cursor ? "/2/files/list_folder/continue" : "/2/files/list_folder", body);
      } catch (e) {
        // No legacy folder at all: nothing to migrate.
        if (/not_found/.test((e as Error).message)) return [];
        throw e;
      }
      for (const e of res.entries) {
        if (e[".tag"] !== "file") continue;
        const full = e.path_display ?? e.path_lower;
        const rel = full.toLowerCase().startsWith(DROPBOX_LEGACY_FOLDER.toLowerCase() + "/") ? full.slice(DROPBOX_LEGACY_FOLDER.length + 1) : full.replace(/^\//, "");
        // The encrypted vault lives in "vault/" under the same app folder: ciphertext, never plain text.
        if (rel.toLowerCase().startsWith(LEGACY_VAULT_SUBFOLDER + "/")) continue;
        out.push({ path: rel, size: e.size ?? 0, modified: e.server_modified ? Date.parse(e.server_modified) : 0, hash: e.content_hash });
      }
      cursor = res.has_more ? res.cursor : undefined;
    } while (cursor);
    return out;
  },
  async readFile(path: string): Promise<Uint8Array> {
    const res = await dropboxFetch("/2/files/download", {
      contentEndpoint: true,
      headers: { "Dropbox-API-Arg": JSON.stringify({ path: `${DROPBOX_LEGACY_FOLDER}/${path}` }) },
    });
    if (!res.ok) throw new Error(`Dropbox ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async moveFile(from: string, to: string): Promise<void> {
    await rpc("/2/files/move_v2", {
      from_path: `${DROPBOX_LEGACY_FOLDER}/${from}`,
      to_path: `${DROPBOX_LEGACY_FOLDER}/${to}`,
      autorename: false,
      allow_ownership_transfer: false,
    });
  },
};

/**
 * Completes the OAuth handshake. Call from the redirect page (or a router
 * handler that runs when `code` is present in the query string).
 */
export async function finishDropboxOAuth(code: string): Promise<void> {
  const verifier = localStorage.getItem(PKCE_KEY);
  if (!verifier) throw new Error("Missing PKCE verifier — restart sign-in.");
  const res = await fetchWithRetry("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: appKey(),
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  }, { label: "dropbox.exchangeToken", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 4000 });
  if (!res.ok) throw new Error(`OAuth exchange failed (${res.status})`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  saveToken({
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000 - 30_000,
  });
  localStorage.removeItem(PKCE_KEY);
}
