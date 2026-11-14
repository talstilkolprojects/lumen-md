/**
 * Read-mode publishing — turn any note into a public URL (Pro feature).
 *
 * The flow:
 *
 *   1. Client calls `publishNote(path)` — POST {path, content, slug?} to the
 *      configured `VITE_PUBLISH_ENDPOINT` (Cloudflare Worker / Vercel edge /
 *      Supabase Edge Function — operator's choice).
 *   2. The endpoint stores the rendered HTML at `lumen.app/p/<slug>` and
 *      returns `{ url, slug }`.
 *   3. `unpublishNote(slug)` flips the document back to private.
 *
 * The server piece is intentionally out of this module. A reference
 * Cloudflare Worker that satisfies the contract is shipped under
 * `mcp-server/publish-worker/` — any HTTP backend that accepts
 * the same JSON shape works.
 *
 * The browser never sees a service-account key. Authorization rides on the
 * user's session JWT (Supabase / Clerk). Anonymous users hit a 401 toast
 * with "Sign in to publish".
 */

import { useAppStore } from "../store/useStore";
import { useEntitlement } from "../billing/useEntitlement";
import { useAuth } from "../auth/useAuth";
import { recordAudit } from "../lib/audit";
import { fetchWithRetry } from "../lib/fetchRetry";

interface MockPublishRecord {
  path: string;
  slug: string;
  visibility: "public" | "unlisted";
  encrypted: boolean;
  createdAt: number;
  updatedAt: number;
  content: string;
}

export interface PublishResult {
  /** Public URL the note can now be read at. */
  url: string;
  /** Slug part of the URL — store on the note's frontmatter. */
  slug: string;
  /** Server-reported expiry, if any (Pro = no expiry, Free trial = 7 days). */
  expiresAt?: number;
}

interface PublishResultPayload {
  url?: unknown;
  slug?: unknown;
  expiresAt?: unknown;
}

const PUBLISH_MOCK_KEY = "lumen.publish.mock-store";

function publishEndpoint(): string | null {
  return (
    import.meta as ImportMeta & { env?: { VITE_PUBLISH_ENDPOINT?: string } }
  ).env?.VITE_PUBLISH_ENDPOINT ?? null;
}

function mockPublishEnabled(): boolean {
  // One name at a time: a whole import.meta.env read inlines every VITE_* value.
  const explicit = (import.meta.env.VITE_PUBLISH_MOCK_ENABLED as string | undefined)?.trim().toLowerCase();
  if (explicit === "1" || explicit === "true" || explicit === "yes") return true;
  if (import.meta.env.DEV) return true;
  try {
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
  } catch {
    return false;
  }
}

function publishTarget(): "remote" | "mock" {
  if (publishEndpoint()) return "remote";
  if (mockPublishEnabled()) return "mock";
  throw new Error("VITE_PUBLISH_ENDPOINT is not set — publishing offline.");
}

function mockStore(): Record<string, MockPublishRecord> {
  try {
    const raw = localStorage.getItem(PUBLISH_MOCK_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveMockStore(store: Record<string, MockPublishRecord>): void {
  try {
    localStorage.setItem(PUBLISH_MOCK_KEY, JSON.stringify(store));
  } catch {
    // Mock publish should stay functional even when storage is unavailable.
  }
}

function toMockPublishUrl(slug: string): string {
  if (typeof window === "undefined") return `/p/${encodeURIComponent(slug)}`;
  const origin = window.location.origin.replace(/\/$/, "");
  return `${origin}/p/${encodeURIComponent(slug)}`;
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeSlug(candidate: string): string {
  return candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .replace(/--+/g, "-")
    .slice(0, 80);
}

async function mockSlug(content: string, path: string, candidate?: string): Promise<string> {
  const requested = candidate ? normalizeSlug(candidate) : "";
  const fallbackBase = await hashText(`${path}\u0000${content}`);
  const fallback = requested || `${path}-${fallbackBase.slice(0, 16)}`;
  const store = mockStore();
  if (!store[fallback] || store[fallback].path === path) {
    const defaultSlug = await hashText(path).then((v) => v.slice(0, 12));
    return fallback || `note-${defaultSlug}`;
  }
  const hashInput = path + "\u0000" + (candidate ?? content);
  const suffix = await hashText(hashInput).then((v) => v.slice(0, 8));
  const candidateWithPath = `${fallback}-${suffix}`;
  return candidateWithPath || `note-${await hashText(path).then((v) => v.slice(0, 12))}`;
}

async function publishToMock(payload: {
  path: string;
  content: string;
  slug?: string;
  visibility: "public" | "unlisted";
  encrypted: boolean;
}): Promise<PublishResult> {
  const slug = await mockSlug(payload.content, payload.path, payload.slug);
  const now = Date.now();
  const existing = mockStore();
  existing[slug] = {
    path: payload.path,
    slug,
    visibility: payload.visibility,
    encrypted: payload.encrypted,
    createdAt: existing[slug]?.createdAt ?? now,
    updatedAt: now,
    content: payload.content,
  };
  saveMockStore(existing);

  const userId = currentUserId();
  if (userId) {
    recordAudit(userId, "doc.publish", {
      payload: {
        path: payload.path,
        slug,
        visibility: payload.visibility,
        encrypted: payload.encrypted,
      },
    });
  }

  return {
    url: toMockPublishUrl(slug),
    slug,
  };
}

async function unpublishFromMock(slug: string): Promise<void> {
  const store = mockStore();
  if (!store[slug]) {
    throw new Error(`Unpublish failed (404)`);
  }
  delete store[slug];
  saveMockStore(store);
}

function authHeader(): Record<string, string> {
  const aiKey = useAppStore.getState().aiKey;
  // The publish endpoint accepts either a Lumen-issued JWT (after Supabase
  // sign-in) OR a workspace AI key as a soft-auth fallback for self-hosted
  // setups. The cloud Lumen instance ignores the AI-key header.
  const headers: Record<string, string> = {};
  if (aiKey) headers["X-Lumen-Key"] = aiKey;
  return headers;
}

function ensurePro(): void {
  const caps = useEntitlement.getState().capabilities;
  // Read-mode publishing is gated to Pro / Team — Free users get a clear
  // upgrade message rather than an opaque 402.
  // (Free tier could allow N publishes per month — adjust here.)
  if (!caps.cloudSync) {
    throw new Error(
      "Publishing is a Pro feature. Upgrade to share read-only links to your notes.",
    );
  }
}


/**
 * Publish a note. Optional knobs:
 *   - `slug`        — custom URL suffix; server otherwise picks a content
 *                     hash.
 *   - `visibility`  — "public" or "unlisted" (server hides from indexes).
 *   - `password`    — when set, the body is AES-GCM encrypted client-side
 *                     before upload. Only readers who know the password can
 *                     decrypt; the server stores ciphertext only.
 */
export async function publishNote(
  path: string,
  content: string,
  opts: {
    slug?: string;
    visibility?: "public" | "unlisted";
    password?: string;
  } = {},
): Promise<PublishResult> {
  ensurePro();
  const body = opts.password
    ? await encryptForPublish(content, opts.password)
    : content;
  if (publishTarget() === "mock") {
    return publishToMock({
      path,
      content: body,
      slug: opts.slug,
      visibility: opts.visibility ?? "public",
      encrypted: !!opts.password,
    });
  }
  const endpoint = publishEndpoint();
  if (!endpoint) throw new Error("Publish endpoint unavailable.");
  const res = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    credentials: "include",
    body: JSON.stringify({
      path,
      content: body,
      slug: opts.slug,
      visibility: opts.visibility ?? "public",
      encrypted: !!opts.password,
    }),
  }, { label: "publish.note" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Publish failed (${res.status}): ${text.slice(0, 160)}`);
  }
  const result = readPublishResult(await res.json());
  // ε.2 — fire-and-forget audit event so SOC-2 evidence shows
  // "user X published note <path> at <ts>". Doesn't block publish.
  const userId = currentUserId();
  if (userId) {
    recordAudit(userId, "doc.publish", {
      payload: { path, slug: result.slug, visibility: opts.visibility ?? "public", encrypted: !!opts.password },
    });
  }
  return result;
}

/**
 * Encrypt the markdown body with a user-chosen password before upload.
 * Wraps the ciphertext in a tiny self-describing JSON envelope so the
 * public read view (or any third-party reader) can decrypt with the
 * password and a few lines of WebCrypto.
 */
async function encryptForPublish(plaintext: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iter: 200_000,
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    cipher: btoa(String.fromCharCode(...cipher)),
  });
}

/** Read the active user id from the auth slice if any. Audit events are
 *  scoped per user; anonymous publishes don't generate audit rows. */
function currentUserId(): string | null {
  return useAuth.getState().user?.id ?? null;
}

export async function unpublishNote(slug: string): Promise<void> {
  ensurePro();
  if (publishTarget() === "mock") {
    await unpublishFromMock(slug);
    return;
  }
  const endpoint = publishEndpoint();
  if (!endpoint) throw new Error("Publish endpoint unavailable.");
  const res = await fetchWithRetry(`${endpoint}/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    credentials: "include",
    headers: authHeader(),
  }, { label: "publish.unpublish" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Unpublish failed (${res.status})`);
  }
  const userId = currentUserId();
  if (userId) {
    recordAudit(userId, "doc.unpublish", { payload: { slug } });
  }
}

/** Local-only inspection: parse `published:` from the frontmatter. */
export function getPublishedSlug(content: string): string | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^published\s*:\s*([\w/-]+)/m);
  return m?.[1] ?? null;
}

/** Persist a slug into the note's frontmatter (idempotent). */
export function setPublishedSlug(content: string, slug: string | null): string {
  const fm = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/);
  if (!fm) {
    return slug == null ? content : `---\npublished: ${slug}\n---\n\n${content}`;
  }
  const block = fm[2];
  const has = /^published\s*:/m.test(block);
  let newBlock: string;
  if (slug == null) {
    newBlock = block.replace(/^published\s*:.*$/m, "").replace(/\n{2,}/g, "\n").trim();
  } else if (has) {
    newBlock = block.replace(/^published\s*:.*$/m, `published: ${slug}`);
  } else {
    newBlock = `${block.replace(/\s*$/, "")}\npublished: ${slug}`;
  }
  return content.replace(fm[0], `${fm[1]}${newBlock}${fm[3]}`);
}

function readPublishResult(data: unknown): PublishResult {
  const payload = data as PublishResultPayload;
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  const slug = typeof payload?.slug === "string" ? payload.slug.trim() : "";
  if (!url || !slug) {
    throw new Error("Malformed publish response. Expected { url, slug }.");
  }
  const expiresAt = typeof payload?.expiresAt === "number" ? payload.expiresAt : undefined;
  return { url, slug, expiresAt };
}
