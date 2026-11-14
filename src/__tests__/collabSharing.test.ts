/**
 * Plan W1.19: real sharing on the Hocuspocus collab server — roles enforced
 * by the server, share links that expire and can be revoked, the room's
 * owner. Runs the real server in-process (as collabServer.test.ts does) and
 * talks to it with the real @hocuspocus/provider.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { tokenRequest, commentsDocName } from "../collab/sharing";
import { RoomTokenError } from "../collab/roomToken";
// @ts-expect-error -- plain ESM server module, no types
import { createCollabServer } from "../../sync-server/collab-server.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { openStore } from "../../sync-server/collab/sqliteStore.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { handleTokenRequest, isDocumentWrite, parseDocumentName, canWrite } from "../../sync-server/collab/sharing.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { readRoomToken, signingKey } from "../../sync-server/collab/roomToken.mjs";

interface Store {
  load(name: string): Uint8Array | null;
  close(): void;
}
interface App {
  listen(): Promise<number>;
  close(): Promise<void>;
  store: Store;
}
interface Share {
  id: string;
  role: string;
  expiresAt: number;
  state: string;
}

const ACCESS = "operator-access-key-for-tests";
const SECRET = "x".repeat(40);
const OWNER = "the-owners-secret-0123456789";
const dirs: string[] = [];
const apps: App[] = [];
const providers: HocuspocusProvider[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lumen-share-"));
  dirs.push(d);
  return d;
}

async function start(): Promise<{ app: App; url: string }> {
  const app = createCollabServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), accessKey: ACCESS, tokenSecret: SECRET, debounceMs: 20, maxDebounceMs: 50, backupIntervalMs: 0, revokeCheckMs: 200 }) as App;
  apps.push(app);
  const port = await app.listen();
  return { app, url: `ws://127.0.0.1:${port}` };
}

const ownerToken = (url: string, room: string) => () => tokenRequest<{ token: string }>(url, { room, owner: OWNER, key: ACCESS }).then((r) => r.token);
const shareToken = (url: string, room: string, share: string) => () => tokenRequest<{ token: string }>(url, { room, share }).then((r) => r.token);
const makeShare = (url: string, room: string, role: string) => tokenRequest<{ share: Share }>(url, { action: "share", room, owner: OWNER, key: ACCESS, role, ttlS: 3600 }).then((r) => r.share);

/** Connect to `name`; resolves once synced. */
function join_(url: string, name: string, token: () => Promise<string>, extra: { onClose?: () => void } = {}): Promise<{ doc: Y.Doc; provider: HocuspocusProvider }> {
  const doc = new Y.Doc();
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url,
      name,
      document: doc,
      token,
      onSynced: () => resolve({ doc, provider }),
      onAuthenticationFailed: ({ reason }) => reject(new Error(`auth failed: ${reason}`)),
      onClose: () => extra.onClose?.(),
    });
    providers.push(provider);
  });
}

/** The server's stored state of `name`, as text of `field`. */
function stored(app: App, name: string, read: (d: Y.Doc) => string): string | null {
  const state = app.store.load(name);
  if (!state) return null;
  const d = new Y.Doc();
  Y.applyUpdate(d, state);
  return read(d);
}

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* ─── Acceptance 1: "view" can't change the document, even by hand ─────── */

describe("roles are enforced by the server", () => {
  it("a viewer's update never reaches the room, even sent by hand; the editor's does", async () => {
    const { app, url } = await start();
    const room = "lumen-share-view";
    const view = await makeShare(url, room, "view");
    const editor = await join_(url, room, ownerToken(url, room));
    editor.doc.getText("t").insert(0, "hello");
    const viewer = await join_(url, room, shareToken(url, room, view.id));
    await vi.waitFor(() => expect(viewer.doc.getText("t").toString()).toBe("hello"), { timeout: 5000 });

    // The viewer changes its copy: its provider sends the update to the server…
    viewer.doc.getText("t").insert(0, "EVIL ");
    viewer.doc.getMap("lumen-comments").set("x", { body: "EVIL" });
    // …and an update built by hand, applied and sent the same way.
    const forged = new Y.Doc();
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(viewer.doc));
    forged.getText("t").insert(0, "FORGED ");
    Y.applyUpdate(viewer.doc, Y.encodeStateAsUpdate(forged, Y.encodeStateVector(viewer.doc)));

    // A later change by the editor is stored; nothing of the viewer's is.
    editor.doc.getText("t").insert(5, "!");
    await vi.waitFor(() => expect(stored(app, room, (d) => d.getText("t").toString())).toBe("hello!"), { timeout: 5000 });
    expect(stored(app, room, (d) => JSON.stringify(d.getMap("lumen-comments").toJSON()))).toBe("{}");
    expect(editor.doc.getText("t").toString()).toBe("hello!");
    const fresh = await join_(url, room, ownerToken(url, room));
    expect(fresh.doc.getText("t").toString()).toBe("hello!");
  });

  it("a commenter writes the room's comments document but not the note", async () => {
    const { app, url } = await start();
    const room = "lumen-share-comment";
    const share = await makeShare(url, room, "comment");
    const editor = await join_(url, room, ownerToken(url, room));
    editor.doc.getText("t").insert(0, "שלום");
    const text = await join_(url, room, shareToken(url, room, share.id));
    const comments = await join_(url, commentsDocName(room), shareToken(url, room, share.id));
    await vi.waitFor(() => expect(text.doc.getText("t").toString()).toBe("שלום"), { timeout: 5000 });
    text.doc.getText("t").insert(0, "EVIL ");
    comments.doc.getMap("lumen-comments").set("c1", { body: "תגובה" });
    editor.doc.getText("t").insert(4, "!");
    await vi.waitFor(() => expect(stored(app, commentsDocName(room), (d) => JSON.stringify(d.getMap("lumen-comments").toJSON()))).toBe('{"c1":{"body":"תגובה"}}'), { timeout: 5000 });
    await vi.waitFor(() => expect(stored(app, room, (d) => d.getText("t").toString())).toBe("שלום!"), { timeout: 5000 });
  });

  it("an editor link edits both documents; tokens for another room are refused", async () => {
    const { app, url } = await start();
    const room = "lumen-share-edit";
    const share = await makeShare(url, room, "edit");
    const guest = await join_(url, room, shareToken(url, room, share.id));
    guest.doc.getText("t").insert(0, "from the guest");
    await vi.waitFor(() => expect(stored(app, room, (d) => d.getText("t").toString())).toBe("from the guest"), { timeout: 5000 });
    await expect(join_(url, "lumen-other-room", shareToken(url, room, share.id))).rejects.toThrow(/auth failed/);
  });
});

/* ─── Acceptance 2: a revoked link is blocked within 5 s ───────────────── */

describe("share links", () => {
  it("a revoked link is cut off within 5 s, and buys no new token", async () => {
    const { url } = await start();
    const room = "lumen-share-revoke";
    const share = await makeShare(url, room, "view");
    let closedAt: number | null = null;
    await join_(url, room, shareToken(url, room, share.id), { onClose: () => (closedAt ??= Date.now()) });
    expect(closedAt).toBeNull();
    const t0 = Date.now();
    await tokenRequest(url, { action: "revoke", room, owner: OWNER, key: ACCESS, share: share.id });
    await vi.waitFor(() => expect(closedAt).not.toBeNull(), { timeout: 5000 });
    expect(closedAt! - t0).toBeLessThan(5000);
    await expect(tokenRequest(url, { room, share: share.id })).rejects.toMatchObject({ reason: "revoked" });
    const status = await tokenRequest<{ state: string }>(url, { action: "status", room, share: share.id });
    expect(status.state).toBe("revoked");
  });

  it("the owner lists the links; a claimed room needs the owner secret for an editor token", async () => {
    const { url } = await start();
    const room = "lumen-share-owner";
    await makeShare(url, room, "view");
    await makeShare(url, room, "comment");
    const list = await tokenRequest<{ shares: Share[] }>(url, { action: "shares", room, owner: OWNER, key: ACCESS });
    expect(list.shares.map((s) => s.role).sort()).toEqual(["comment", "view"]);
    await expect(tokenRequest(url, { room, key: ACCESS })).rejects.toBeInstanceOf(RoomTokenError);
    await expect(tokenRequest(url, { action: "shares", room, owner: "someone-elses-secret-01234", key: ACCESS })).rejects.toMatchObject({ reason: "owner-required" });
  });
});

/* ─── The pure parts ───────────────────────────────────────────────────── */

describe("sharing logic", () => {
  const key = signingKey(SECRET);
  const fresh = () => openStore(tempDir()) as Store & Record<string, unknown>;

  it("a token never outlives its link, and carries its role and share", () => {
    const store = fresh();
    const now = Date.UTC(2026, 10, 10);
    const s = handleTokenRequest({ action: "share", room: "r", owner: OWNER, role: "comment", ttlS: 120 }, { store, key, tokenTtlS: 600, nowMs: now }).share;
    const tok = handleTokenRequest({ room: "r", share: s.id }, { store, key, tokenTtlS: 600, nowMs: now });
    expect(tok.expiresAt).toBe(now + 120_000);
    expect(readRoomToken(key, tok.token, "r", { nowMs: now })).toMatchObject({ ok: true, role: "comment", share: s.id });
    expect(handleTokenRequest({ room: "r", share: s.id }, { store, key, tokenTtlS: 600, nowMs: now + 120_000 })).toEqual({ error: "expired" });
    store.close();
  });

  it("an unclaimed room works as before; the first share claims it", () => {
    const store = fresh();
    const ctx = { store, key, tokenTtlS: 600 };
    expect(handleTokenRequest({ room: "r" }, ctx).role).toBe("edit");
    expect(handleTokenRequest({ room: "r", action: "share", role: "view", owner: "short" }, ctx)).toEqual({ error: "owner-required" });
    expect(handleTokenRequest({ room: "r", action: "share", role: "view", owner: OWNER }, ctx).share.role).toBe("view");
    expect(handleTokenRequest({ room: "r" }, ctx)).toEqual({ error: "owner-required" });
    expect(handleTokenRequest({ room: "r", owner: OWNER }, ctx).role).toBe("edit");
    store.close();
  });

  it("document names, write rights and the message guard", () => {
    expect(parseDocumentName("room-1~comments")).toEqual({ room: "room-1", kind: "comments" });
    expect(parseDocumentName("room-1")).toEqual({ room: "room-1", kind: "text" });
    expect(parseDocumentName("../etc")).toBeNull();
    expect([canWrite("view", "text"), canWrite("view", "comments"), canWrite("comment", "text"), canWrite("comment", "comments"), canWrite("edit", "text")]).toEqual([false, false, false, true, true]);
    const msg = (...rest: number[]) => new Uint8Array([4, 0x72, 0x6f, 0x6f, 0x6d, ...rest]);
    expect(isDocumentWrite(msg(0, 2, 1, 0))).toBe(true); // update
    expect(isDocumentWrite(msg(0, 1, 0))).toBe(true); // sync step 2
    expect(isDocumentWrite(msg(0, 0, 0))).toBe(false); // sync step 1 (a request)
    expect(isDocumentWrite(msg(1, 3))).toBe(false); // awareness
    expect(isDocumentWrite(new Uint8Array([0xff]))).toBe(false);
  });
});
