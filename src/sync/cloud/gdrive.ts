/**
 * Google Drive — OAuth (PKCE, `drive.file` scope: only files Lumen created)
 * and the plain-text side the migration to encrypted sync reads from
 * (plan 3.5). The encrypted `SyncProvider` over Drive is
 * src/sync/e2ee/providers/gdrive.ts; it uses `gdriveFetch` from here.
 *
 * Configuration: `VITE_GDRIVE_CLIENT_ID` — the OAuth client id (a public
 * identifier, not a secret; plan 15.5). Without it the OAuth flow is
 * unavailable and `gdriveConfigured()` is false. Tokens live in the secret store.
 */

import { fetchWithRetry } from "../../lib/fetchRetry";
import type { CloudFile, LegacyCloudStore } from "./types";
import { getSecret, setSecret } from "../../lib/secretStore";

const TOKEN_KEY = "lumen.cloud.gdrive.token";
const REFRESH_KEY = "lumen.cloud.gdrive.refresh";
const PKCE_KEY = "lumen.cloud.gdrive.pkce";

interface TokenSet {
  access: string;
  refresh?: string;
  expiresAt: number;
}

/** Is the OAuth client configured? (plan 15.5) */
export function gdriveConfigured(): boolean {
  return !!clientId();
}

function clientId(): string {
  return (
    (import.meta as ImportMeta & { env?: { VITE_GDRIVE_CLIENT_ID?: string } })
      .env?.VITE_GDRIVE_CLIENT_ID ?? ""
  );
}

function redirectUri(): string {
  const env = (
    import.meta as ImportMeta & { env?: { VITE_GDRIVE_REDIRECT?: string } }
  ).env?.VITE_GDRIVE_REDIRECT;
  return env ?? `${location.origin}/oauth/gdrive`;
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

async function sha256B64Url(input: string): Promise<string> {
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
  if (!refresh) throw new Error("Google Drive is disconnected — sign in again.");
  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId(),
    }),
  }, { label: "gdrive.refreshToken", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 4000 });
  if (!res.ok) {
    clearToken();
    throw new Error(`Google refresh failed (${res.status})`);
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
 * An authenticated request to the Drive API (`path` under
 * `https://www.googleapis.com`, or a full URL). Returns the raw response.
 */
export async function gdriveFetch(
  path: string,
  init: RequestInit = {},
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (i, o) => fetch(i, o),
): Promise<Response> {
  const access = await getAccessToken();
  const url = path.startsWith("http") ? path : `https://www.googleapis.com${path}`;
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${access}`);
  return fetchImpl(url, { ...init, headers });
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const access = await getAccessToken();
  const url = path.startsWith("http") ? path : `https://www.googleapis.com${path}`;
  const headers = new Headers(opts.headers ?? {});
  headers.set("Authorization", `Bearer ${access}`);
  const res = await fetchWithRetry(url, { ...opts, headers }, { label: "gdrive.api", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 2500 });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Drive ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? await res.json() : await res.text()) as T;
}

/* ─── The plain-text folder (migration reads it) ─────────────────────── */

/** The folder an earlier Lumen synced plain-text notes into: `appProperties.lumen=true`. Null when there is none. */
async function legacyFolder(): Promise<string | null> {
  const search = await api<{ files: { id: string }[] }>(
    `/drive/v3/files?q=${encodeURIComponent(
      "mimeType='application/vnd.google-apps.folder' and appProperties has { key='lumen' and value='true' } and trashed=false",
    )}&fields=files(id,name)`,
  );
  return search.files[0]?.id ?? null;
}

async function fileId(folder: string, name: string): Promise<string | null> {
  const search = await api<{ files: { id: string }[] }>(
    `/drive/v3/files?q=${encodeURIComponent(`'${folder}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`)}&fields=files(id)`,
  );
  return search.files[0]?.id ?? null;
}

async function subfolder(parent: string, name: string): Promise<string> {
  const existing = await api<{ files: { id: string }[] }>(
    `/drive/v3/files?q=${encodeURIComponent(
      `'${parent}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    )}&fields=files(id)`,
  );
  if (existing.files[0]) return existing.files[0].id;
  const created = await api<{ id: string }>("/drive/v3/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parent] }),
  });
  return created.id;
}

export const gdriveLegacy: LegacyCloudStore = {
  name: "gdrive",
  isConnected(): boolean {
    return !!getSecret(TOKEN_KEY);
  },
  async connect(): Promise<void> {
    if (!clientId()) {
      throw new Error("VITE_GDRIVE_CLIENT_ID is not set — see .env.example.");
    }
    const verifier = randomString(64);
    const challenge = await sha256B64Url(verifier);
    localStorage.setItem(PKCE_KEY, verifier);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId());
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/drive.file");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent"); // force refresh-token issuance
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    location.assign(url.toString());
  },
  async disconnect(): Promise<void> {
    clearToken();
  },
  async listFiles(): Promise<CloudFile[]> {
    const folder = await legacyFolder();
    if (!folder) return [];
    type Entry = { id: string; name: string; size?: string; modifiedTime?: string; md5Checksum?: string; mimeType?: string };
    const out: CloudFile[] = [];
    let pageToken: string | undefined;
    do {
      const url =
        `/drive/v3/files?q=${encodeURIComponent(`'${folder}' in parents and trashed=false`)}` +
        `&fields=nextPageToken,files(id,name,size,modifiedTime,md5Checksum,mimeType)` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const page = await api<{ nextPageToken?: string; files: Entry[] }>(url);
      for (const f of page.files) {
        if (f.mimeType === "application/vnd.google-apps.folder") continue;
        out.push({ path: f.name, size: Number(f.size ?? 0), modified: f.modifiedTime ? Date.parse(f.modifiedTime) : 0, hash: f.md5Checksum });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  },
  async readFile(path: string): Promise<Uint8Array> {
    const folder = await legacyFolder();
    const id = folder ? await fileId(folder, path) : null;
    if (!id) throw new Error(`Not found: ${path}`);
    const res = await gdriveFetch(`/drive/v3/files/${id}?alt=media`);
    if (!res.ok) throw new Error(`Google Drive ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async moveFile(from: string, to: string): Promise<void> {
    // Both paths are "<name>" or "<backup folder>/<name>" (a subfolder of the
    // legacy folder): the backup step moves one way, revert the other.
    const folder = await legacyFolder();
    if (!folder) throw new Error(`Not found: ${from}`);
    const split = (p: string) => {
      const slash = p.lastIndexOf("/");
      return slash >= 0 ? { dir: p.slice(0, slash), name: p.slice(slash + 1) } : { dir: "", name: p };
    };
    const src = split(from);
    const dst = split(to);
    const source = src.dir ? await subfolder(folder, src.dir) : folder;
    const id = await fileId(source, src.name);
    if (!id) throw new Error(`Not found: ${from}`);
    const target = dst.dir ? await subfolder(folder, dst.dir) : folder;
    await api(`/drive/v3/files/${id}?addParents=${target}&removeParents=${source}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: dst.name }),
    });
  },
};

/** Completes the OAuth handshake. Call from the redirect handler. */
export async function finishGDriveOAuth(code: string): Promise<void> {
  const verifier = localStorage.getItem(PKCE_KEY);
  if (!verifier) throw new Error("Missing PKCE verifier — restart sign-in.");
  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId(),
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  }, { label: "gdrive.exchangeToken", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 4000 });
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
