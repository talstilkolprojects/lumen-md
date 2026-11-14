/**
 * Plan W1.19: comment threads on a text range — anchored with Yjs relative
 * positions (they survive edits around them, Hebrew included), @mentions,
 * replies and resolving, kept in Yjs and in a sidecar file next to the note.
 * And the client side of sharing: links, "Shared with me", server-only
 * rooms, the owner secret, the lazy English.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Y from "yjs";
import { addComment, commentsMentioning, extractMentions, listComments, replyToComment, resolveAnchor, threadMentions, toggleResolved } from "../collab/comments";
import { bindCommentsSidecar, exportComments, importComments, parseSidecar, serializeSidecar, sidecarPath } from "../collab/commentsSidecar";
import { canComment, canEdit, commentsDocName, ensureOwnerSecret, forgetShared, isServerOnly, listSharedWithMe, markServerOnly, ownerSecret, readShareFromHash, rememberShared, shareLink, tokenPayload } from "../collab/sharing";
import { getSecret, __resetSecretStore } from "../lib/secretStore";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AUTHOR = { name: "דנה", color: "#c33" };
const HEBREW = ["שלום", " עולם", "ְבָּ", "א", "ת", "״", "׳", " ", "\n", "abc", "١٢"];

beforeEach(() => {
  localStorage.clear();
  __resetSecretStore();
});

/* ─── Acceptance 3 ─────────────────────────────────────────────────────── */

describe("a comment on Hebrew text stays anchored", () => {
  it("after 100 random edits around it, in another peer's document too", () => {
    const quote = "פסקה חשובה מאוד";
    const a = new Y.Doc();
    const text = a.getText("lumen");
    text.insert(0, `פתיחה. ${quote} סיום.\nשורה שנייה עם עוד מילים.`);
    const from = text.toString().indexOf(quote);
    const comments = new Y.Doc(); // the room's comments document (server-only rooms)
    const c = addComment(comments, text, "צריך לבדוק @נועה", from, from + quote.length, AUTHOR);

    // A second peer, synced, edits concurrently.
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const random = rng(2026);
    for (let i = 0; i < 100; i++) {
      const doc = i % 2 ? a : b;
      const t = doc.getText("lumen");
      const s = t.toString();
      const start = s.indexOf(quote);
      // Somewhere outside the quoted range: before it or after it.
      const before = random() < 0.5;
      const lo = before ? 0 : start + quote.length;
      const hi = before ? start : s.length;
      const at = lo + Math.floor(random() * (hi - lo + 1));
      if (random() < 0.65 || hi - lo < 2) t.insert(at, HEBREW[Math.floor(random() * HEBREW.length)]);
      else {
        const len = Math.min(1 + Math.floor(random() * 3), (before ? start : s.length) - at);
        if (len > 0) t.delete(at, len);
      }
      if (i % 7 === 0) {
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
      }
    }
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(a.getText("lumen").toString()).toBe(b.getText("lumen").toString());

    for (const doc of [a, b]) {
      const at = resolveAnchor(doc, listComments(comments).find((x) => x.id === c.id)!);
      expect(at).not.toBeNull();
      expect(doc.getText("lumen").toString().slice(at!.from, at!.to)).toBe(quote);
    }
  });
});

/* ─── Threads ──────────────────────────────────────────────────────────── */

describe("threads", () => {
  it("@mentions in Hebrew and English, not e-mail addresses; replies and resolve", () => {
    expect(extractMentions("@נועה ו-@Dan.Levi, ראו גם (@שירה) dan@example.com @נועה.")).toEqual(["נועה", "Dan.Levi", "שירה"]);
    const doc = new Y.Doc();
    const text = doc.getText("lumen");
    text.insert(0, "טקסט לדוגמה");
    const c = addComment(doc, text, "מה דעתך @אבי?", 0, 4, AUTHOR);
    expect(c.mentions).toEqual(["אבי"]);
    replyToComment(doc, c.id, "מסכים, @Dana", { name: "אבי", color: "#33c" });
    const thread = listComments(doc)[0];
    expect(thread.replies[0].mentions).toEqual(["Dana"]);
    expect(threadMentions(thread)).toEqual(["אבי", "Dana"]);
    expect(commentsMentioning(doc, "dana").map((x) => x.id)).toEqual([c.id]);
    toggleResolved(doc, c.id);
    expect(listComments(doc, { onlyOpen: true })).toEqual([]);
    toggleResolved(doc, c.id);
    expect(listComments(doc, { onlyOpen: true })).toHaveLength(1);
  });
});

/* ─── Sidecar ──────────────────────────────────────────────────────────── */

describe("sidecar file", () => {
  it("next to the note; round trip into a new room re-anchors on the quote", () => {
    expect(sidecarPath("notes/plan.md")).toBe("notes/plan.comments.json");
    expect(sidecarPath("a/b")).toBe("a/b.comments.json");
    const doc = new Y.Doc();
    const text = doc.getText("lumen");
    text.insert(0, "אחת שתיים שלוש שתיים");
    const at = text.toString().lastIndexOf("שתיים");
    const c = addComment(doc, text, "השני", at, at + 5, AUTHOR);
    replyToComment(doc, c.id, "כן", AUTHOR);
    const side = exportComments(doc, text);
    expect(side.threads[0]).toMatchObject({ quote: "שתיים", from: at, to: at + 5 });
    const parsed = parseSidecar(serializeSidecar(side))!;
    expect(parsed.threads).toHaveLength(1);

    // A new room: same text with an edit in front, different Yjs items.
    const room = new Y.Doc();
    const rtext = room.getText("lumen");
    rtext.insert(0, "הקדמה. אחת שתיים שלוש שתיים");
    const comments = new Y.Doc();
    expect(importComments(comments, rtext, parsed)).toBe(1);
    expect(importComments(comments, rtext, parsed)).toBe(0); // same ids: nothing twice
    const back = listComments(comments)[0];
    const r = resolveAnchor(room, back)!;
    // The occurrence nearest the saved offset: the second "שתיים".
    expect(rtext.toString().slice(r.from, r.to)).toBe("שתיים");
    expect(r.from).toBe(rtext.toString().lastIndexOf("שתיים"));
    expect(back.replies).toHaveLength(1);
  });

  it("refuses files that aren't a sidecar; a deleted quote keeps its last text", () => {
    expect(parseSidecar("not json")).toBeNull();
    expect(parseSidecar(JSON.stringify({ version: 9, threads: [] }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ version: 1, threads: [{ id: 1 }] }))!.threads).toEqual([]);
    const doc = new Y.Doc();
    const text = doc.getText("lumen");
    text.insert(0, "abc מחק אותי xyz");
    addComment(doc, text, "x", 4, 11, AUTHOR);
    const first = exportComments(doc, text);
    text.delete(4, 7);
    const second = exportComments(doc, text, first);
    expect(second.threads[0]).toMatchObject({ quote: "מחק אות", from: 4, to: 11 });
  });

  it("is written after a change, read back on start, and only by those who may edit", async () => {
    const files = new Map<string, string>();
    const io = { read: async (p: string) => files.get(p) ?? null, write: async (p: string, t: string) => void files.set(p, t) };
    const doc = new Y.Doc();
    const text = doc.getText("lumen");
    text.insert(0, "הערה כאן");
    let editable = true;
    let asked = 0;
    const canWrite = () => (asked++, editable);
    const stop = bindCommentsSidecar(doc, text, "n.md", io, { canWrite, delayMs: 5 });
    addComment(doc, text, "ראשונה", 0, 4, AUTHOR);
    await expect.poll(() => files.get("n.comments.json") ?? "").toContain("ראשונה");
    stop();

    // A new session on the same note brings the thread back.
    const doc2 = new Y.Doc();
    const text2 = doc2.getText("lumen");
    text2.insert(0, "הערה כאן");
    const stop2 = bindCommentsSidecar(doc2, text2, "n.md", io, { canWrite: () => true, delayMs: 5 });
    await expect.poll(() => listComments(doc2).length).toBe(1);
    stop2();

    // Someone who may not edit writes nothing.
    editable = false;
    files.clear();
    const doc3 = new Y.Doc();
    const text3 = doc3.getText("lumen");
    text3.insert(0, "x");
    asked = 0;
    const stop3 = bindCommentsSidecar(doc3, text3, "m.md", io, { canWrite, delayMs: 5 });
    addComment(doc3, text3, "לא", 0, 1, AUTHOR);
    // The save ran (it asked whether it may write) and wrote nothing.
    await expect.poll(() => asked).toBeGreaterThan(0);
    stop3();
    expect(files.has("m.comments.json")).toBe(false);
  });
});

/* ─── Client side of sharing ───────────────────────────────────────────── */

describe("sharing on the client", () => {
  it("roles", () => {
    expect([canEdit("edit"), canEdit("comment"), canEdit("view")]).toEqual([true, false, false]);
    expect([canComment("edit"), canComment("comment"), canComment("view")]).toEqual([true, true, false]);
    expect(commentsDocName("lumen-abc")).toBe("lumen-abc~comments");
  });

  it("links carry the room, its key and the share id; the id is read back", () => {
    const link = shareLink("lumen-abc", "k&y=1", "AbC_d-123456", "https://lumen-md.vercel.app/");
    expect(link).toBe("https://lumen-md.vercel.app/#room=lumen-abc&password=k%26y%3D1&share=AbC_d-123456");
    expect(readShareFromHash(new URL(link).hash)).toBe("AbC_d-123456");
    expect(readShareFromHash("#room=x&password=y")).toBeNull();
    expect(readShareFromHash("#room=x&share=a<b")).toBeNull();
  });

  it("the owner secret lives in the encrypted secret store; tokens ask with the share, else as the owner", async () => {
    expect(ownerSecret("r")).toBeNull();
    expect(tokenPayload("r", { accessKey: "k" })).toEqual({ room: "r", key: "k" });
    const s = await ensureOwnerSecret("r");
    expect(s.length).toBeGreaterThanOrEqual(22);
    expect(await ensureOwnerSecret("r")).toBe(s);
    expect(getSecret("lumen.collab.owner.r")).toBe(s);
    expect(tokenPayload("r", { accessKey: "k" })).toEqual({ room: "r", key: "k", owner: s });
    expect(tokenPayload("r", { share: "abc", accessKey: "k" })).toEqual({ room: "r", share: "abc" });
  });

  it("a shared room is server-only, and a share link always is", () => {
    expect(isServerOnly("r")).toBe(false);
    expect(isServerOnly("r", "abc")).toBe(true);
    markServerOnly("r");
    expect(isServerOnly("r")).toBe(true);
    localStorage.setItem("lumen.collab.serverOnly.v1", "{broken");
    expect(isServerOnly("other")).toBe(true); // unknown: the safe side
  });

  it("Shared with me keeps one entry per link, newest first", () => {
    rememberShared({ room: "a", share: "s1", role: "view", expiresAt: null, link: "#1", title: "ראשון", openedAt: 1 });
    rememberShared({ room: "b", share: "s2", role: "comment", expiresAt: null, link: "#2", title: "שני", openedAt: 2 });
    rememberShared({ room: "a", share: "s1", role: "edit", expiresAt: null, link: "#1", title: "ראשון", openedAt: 3 });
    expect(listSharedWithMe().map((x) => [x.share, x.role])).toEqual([["s1", "edit"], ["s2", "comment"]]);
    forgetShared("s2");
    expect(listSharedWithMe()).toHaveLength(1);
  });

  it("the share dialog's English is lazy: not in the startup bundle, registered by its domain", async () => {
    const lazy = JSON.parse(readFileSync(resolve(__dirname, "../i18n/lazy/sharing.json"), "utf8")) as Record<string, string>;
    const index = readFileSync(resolve(__dirname, "../i18n/index.ts"), "utf8");
    expect(Object.keys(lazy).length).toBeGreaterThan(30);
    for (const k of Object.keys(lazy)) expect(index.includes(`"${k}":`), k).toBe(false);
    const { t } = await import("../i18n");
    await import("../collab/sharingStrings");
    expect(t("share.role.view")).toBe("Can view");
    expect(t("share.state.active", { date: "1.1" })).toBe("until 1.1");
  });
});
