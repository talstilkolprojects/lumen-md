/**
 * Sync that explains itself (plan W1.8): per-file and per-folder state, the
 * activity log and its time estimate, selective sync per device, background
 * / resume behaviour, the file tree's badges — and the acceptance check that
 * an excluded file never leaves the device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { memoryProvider, type SyncProvider } from "../sync/e2ee/provider";
import { E2eeSync } from "../sync/e2ee/engine";
import { unseal } from "../sync/e2ee/keys";
import { openManifest, manifestName } from "../sync/e2ee/manifest";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { keepBothResolver, type ConflictResolution, type ConflictResolver } from "../sync/e2ee/conflict";
import type { SyncEvent } from "../sync/e2ee/activity";
import { ActivityLog } from "../sync/e2ee/activity";
import { RoundEstimator, describeSecondsLeft } from "../sync/e2ee/estimate";
import { compileRules, loadRules, normalizeRules, parseRulesForm, saveRules, SyncRulesUnreadableError, NO_RULES } from "../sync/e2ee/rules";
import { computeFileStates, countStates, folderStates, type HoldReason } from "../sync/e2ee/status";
import { installBackgroundSync, resumeNotice, NOTICE_AFTER_MS } from "../sync/e2ee/background";
import { badgeCss, cssString, applyTreeBadges, clearTreeBadges } from "../sync/e2ee/ui/treeBadges";
import { createSession } from "../sync/e2ee/ui/session";
import { SyncActivity, describeEvent, formatBytes } from "../sync/e2ee/ui/SyncActivity";
import { __setProviderStore, type ProviderSettings } from "../sync/e2ee/providers";
import { __resetSecretStore } from "../lib/secretStore";
import { fakeFetch, text } from "./helpers/fakeServers/http";
import { fakeWebdav } from "./helpers/fakeServers/webdav";
import { joinVault, newVault, PASSPHRASE, TEST_ITERATIONS } from "./helpers/e2ee";

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

/** A provider that remembers every object written to it. */
function recording(): { provider: SyncProvider & { objects: Map<string, unknown> }; puts: Array<{ name: string; data: Uint8Array }> } {
  const inner = memoryProvider();
  const puts: Array<{ name: string; data: Uint8Array }> = [];
  return {
    puts,
    provider: {
      ...inner,
      async put(name, data, cond) {
        puts.push({ name, data: data.slice() });
        return inner.put(name, data, cond);
      },
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

/* ─── Acceptance: an excluded file does not leave the device ─────────────── */

describe("selective sync: an excluded file never leaves the device", () => {
  it("folders, file types and the attachment size limit keep files here; nothing of them is uploaded, not even encrypted", async () => {
    const { provider, puts } = recording();
    const a = await newVault(provider);
    const secret = bytes(300_000, 42);
    const video = bytes(2 * 1024 * 1024, 9);
    a.files.files.set("Private/diary.md", new TextEncoder().encode("# יומן פרטי"));
    a.files.files.set("clips/talk.mov", secret);
    a.files.files.set("scans/big.pdf", video);
    a.files.set("notes/a.md", "# a");
    a.files.files.set("scans/small.pdf", bytes(1000, 3));
    const events: SyncEvent[] = [];
    const sync = new E2eeSync({ provider, keys: a.keys, local: a.files, store: a.store, exclude: compileRules({ folders: ["Private"], extensions: ["mov"], maxAttachmentBytes: 1024 * 1024 }), onEvent: (e) => events.push(e) });
    puts.length = 0;
    const r = await sync.sync();
    expect(r.uploaded).toBe(2); // notes/a.md and scans/small.pdf

    // No uploaded object decrypts to an excluded file, and far fewer bytes left than any of them.
    const excluded = [new TextEncoder().encode("# יומן פרטי"), secret, video];
    for (const { name, data } of puts) {
      const plain = await unseal(a.keys.blobs, a.keys.vaultId, "blob", name, data).catch(() => null);
      if (plain) for (const x of excluded) expect(plain.length === x.length && plain.every((b, i) => b === x[i])).toBe(false);
    }
    expect(puts.reduce((n, p) => n + p.data.length, 0)).toBeLessThan(secret.length);
    // The manifest does not even name them.
    const mname = await manifestName(a.keys);
    const { manifest } = await openManifest(a.keys, (await provider.get(mname))!.data, mname);
    expect(Object.keys(manifest.files).sort()).toEqual(["notes/a.md", "scans/small.pdf"]);
    // The activity log says what stayed and why.
    expect(events.filter((e) => e.kind === "excluded").map((e) => (e.kind === "excluded" ? `${e.path} ${e.reason}` : ""))).toEqual(["Private/diary.md folder:Private", "clips/talk.mov type:mov", "scans/big.pdf size:1048576"]);
    expect(events.filter((e) => e.kind === "upload").map((e) => (e.kind === "upload" ? e.path : ""))).toEqual(["notes/a.md", "scans/small.pdf"]);
  });

  it("a file excluded on one device: a newer version is not downloaded and a deletion there is not applied here", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("Videos/a.md", "v1");
    a.files.set("keep.md", "k");
    await a.sync.sync();
    const b = await joinVault("B", provider);
    const bs = new E2eeSync({ provider, keys: b.keys, local: b.files, store: b.store, exclude: compileRules({ folders: [], extensions: [], maxAttachmentBytes: null }) });
    await bs.sync();
    expect(b.files.text("Videos/a.md")).toBe("v1");
    // B now leaves Videos/ out.
    const bx = new E2eeSync({ provider, keys: b.keys, local: b.files, store: b.store, exclude: compileRules({ folders: ["Videos"], extensions: [], maxAttachmentBytes: null }) });
    a.files.set("Videos/a.md", "v2");
    await a.sync.sync();
    await bx.sync();
    expect(b.files.text("Videos/a.md")).toBe("v1");
    a.files.delete("Videos/a.md");
    await a.sync.sync();
    await bx.sync();
    expect(b.files.text("Videos/a.md")).toBe("v1");
    // B's own edit stays on B too.
    b.files.set("Videos/a.md", "edited on B");
    await bx.sync();
    await a.sync.sync();
    expect(a.files.files.has("Videos/a.md")).toBe(false);
    expect((await bx.fileStates()).get("Videos/a.md")).toEqual({ state: "excluded", reason: "folder:Videos" });
  });

  it("a size the listing didn't know is checked on the bytes before upload", async () => {
    const { provider, puts } = recording();
    const a = await newVault(provider);
    const big = bytes(5000);
    const files = memoryFiles();
    files.files.set("x.bin", big);
    const local = { ...files, list: async () => (await files.list()).map(({ path, hash }) => ({ path, hash })) }; // no sizes
    const sync = new E2eeSync({ provider, keys: a.keys, local, store: memoryStateStore(), exclude: compileRules({ folders: [], extensions: [], maxAttachmentBytes: 1000 }) });
    puts.length = 0;
    expect((await sync.sync()).uploaded).toBe(0);
    expect(puts.every((p) => p.data.length < 2000)).toBe(true);
  });
});

describe("memory on a first sync of a large vault", () => {
  it("keeps ancestor bytes for notes, not for attachments over the limit", async () => {
    const { BASE_BYTES_LIMIT } = await import("../sync/e2ee/engine");
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("n.md", "# note");
    a.files.files.set("big.bin", bytes(BASE_BYTES_LIMIT + 1));
    expect((await a.sync.sync()).uploaded).toBe(2);
    expect(await a.store.getBase("n.md")).not.toBeNull();
    expect(await a.store.getBase("big.bin")).toBeNull();
    const b = await joinVault("B", provider);
    expect((await b.sync.sync()).downloaded).toBe(2);
    expect(await b.store.getBase("big.bin")).toBeNull();
    expect(b.files.files.get("big.bin")?.length).toBe(BASE_BYTES_LIMIT + 1);
    // A later edit of the attachment still syncs (it is a new version, no merge needed).
    const old = (await a.files.list()).find((f) => f.path === "big.bin")!.hash;
    expect(await a.files.write("big.bin", bytes(BASE_BYTES_LIMIT + 2, 1), old)).toBe(true);
    await a.sync.sync();
    expect((await b.sync.sync()).downloaded).toBe(1);
    expect(b.files.files.get("big.bin")?.length).toBe(BASE_BYTES_LIMIT + 2);
  });
});

/* ─── Per-file and per-folder state ────────────────────────────────────── */

describe("per-file and per-folder state", () => {
  it("synced, pending both ways, conflict, excluded — and folders take the most urgent state inside", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("notes/one.md", "1");
    a.files.set("notes/two.md", "2");
    a.files.set("other/x.md", "x");
    await a.sync.sync();
    const hold: ConflictResolver = async () => ({ kind: "hold" });
    const b = await joinVault("B", provider, hold);
    await b.sync.sync();
    expect([...(await b.sync.fileStates()).values()].every((s) => s.state === "synced")).toBe(true);

    a.files.set("notes/one.md", "1 from A");
    b.files.set("notes/one.md", "1 from B");
    a.files.set("other/x.md", "x2");
    await a.sync.sync();
    await b.sync.sync();
    b.files.set("notes/two.md", "edited after the round");
    const st = await b.sync.fileStates({ rescan: true });
    expect(st.get("notes/one.md")).toEqual({ state: "conflict", reason: "conflict" });
    expect(st.get("notes/two.md")).toEqual({ state: "pending", direction: "up" });
    expect(st.get("other/x.md")).toEqual({ state: "synced" });
    expect(folderStates(st).get("notes")).toBe("conflict");
    expect(countStates(st)).toEqual({ synced: 1, pending: 1, conflict: 1, error: 0, excluded: 0 });
  });

  it("the pure computation: remote-only, pending down, retry, clash, a file excluded everywhere", () => {
    const e = (ver: number, extra: object = {}) => ({ ver, rev: `r${ver}`, hash: `h${ver}`, size: 10, by: "d", ...extra });
    const files = computeFileStates({
      local: new Map([["a.md", { hash: "h1" }], ["b.md", { hash: "h1" }], ["c.md", { hash: "h1" }], ["d.md", { hash: "h1" }], ["V/v.mp4", { hash: "h1", size: 9e9 }]]),
      base: { "a.md": e(1), "b.md": e(1), "c.md": e(1), "d.md": e(1), "V/v.mp4": e(1) },
      remote: { "a.md": e(1), "b.md": e(2), "c.md": e(1), "d.md": e(1), "new.md": e(1), "V/v.mp4": e(1) },
      holds: new Map<string, HoldReason>([["c.md", "retry"], ["d.md", "clash"]]),
      exclude: compileRules({ folders: [], extensions: [], maxAttachmentBytes: 100 }),
    });
    expect(Object.fromEntries([...files].map(([p, s]) => [p, s.state + (s.direction ? `:${s.direction}` : "")]))).toEqual({
      "a.md": "synced",
      "b.md": "pending:down",
      "c.md": "pending",
      "d.md": "error",
      "new.md": "pending:down",
      "V/v.mp4": "excluded",
    });
    expect(folderStates(files).get("V")).toBe("excluded");
    expect(folderStates(new Map([["V/a", { state: "excluded" as const }], ["V/b", { state: "synced" as const }]])).get("V")).toBe("synced");
  });
});

/* ─── Activity ─────────────────────────────────────────────────────────── */

describe("activity log", () => {
  it("reports each step; a conflict is reported before the conflict dialog is even asked", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("n.md", "base");
    await a.sync.sync();
    const events: SyncEvent[] = [];
    let seenAtDialog: string[] = [];
    const resolver: ConflictResolver = async () => {
      seenAtDialog = events.map((e) => e.kind);
      return { kind: "keepBoth" };
    };
    const b = await joinVault("B", provider);
    const bs = new E2eeSync({ provider, keys: b.keys, local: b.files, store: b.store, resolver, onEvent: (e) => events.push(e) });
    await bs.sync();
    a.files.set("n.md", "from A");
    b.files.set("n.md", "from B");
    await a.sync.sync();
    events.length = 0;
    await bs.sync();
    expect(seenAtDialog).toContain("conflict");
    expect(events[0].kind).toBe("start");
    expect(events.at(-1)?.kind).toBe("done");
    expect(events.some((e) => e.kind === "download" && e.path.includes("(conflict"))).toBe(true);
  });

  it("a listener that throws never breaks a round; the log keeps the newest and one line per exclusion", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("x.md", "x");
    const sync = new E2eeSync({ provider, keys: a.keys, local: a.files, store: a.store, onEvent: () => {
      throw new Error("panel bug");
    } });
    expect((await sync.sync()).uploaded).toBe(1);

    const log = new ActivityLog(3);
    for (let i = 0; i < 5; i++) log.push({ kind: "excluded", at: i, path: "V/a", reason: "folder:V", direction: "up" });
    expect(log.list()).toHaveLength(1);
    for (let i = 0; i < 5; i++) log.push({ kind: "start", at: i });
    expect(log.list()).toHaveLength(3);
    expect(describeEvent({ kind: "excluded", at: 0, path: "V/a", reason: "folder:V", direction: "up" })).toBe("Kept on this device: V/a (folder V)");
    expect(describeEvent({ kind: "upload", at: 0, path: "a.md", bytes: 2048, direction: "up" })).toMatch(/^Sent a\.md \(2 kB|^Sent a\.md \(2 KB/);
    expect(formatBytes(3 * 1024 * 1024)).toMatch(/3 MB/);
  });
});

/* ─── Time estimate ────────────────────────────────────────────────────── */

describe("time estimate", () => {
  it("from the round's own progress, weighted by files and bytes", () => {
    let now = 0;
    const est = new RoundEstimator({ prior: null, now: () => now });
    est.push({ kind: "start", at: 0 });
    est.push({ kind: "plan", at: 0, direction: "down", files: 10, bytes: 1000 });
    expect(est.progress().secondsLeft).toBeNull(); // nothing to base it on yet
    now = 10_000;
    for (let i = 0; i < 5; i++) est.push({ kind: "download", at: now, path: `f${i}`, bytes: 100, direction: "down" });
    const p = est.progress();
    expect(p.fraction).toBeCloseTo(0.5);
    expect(p.secondsLeft).toBeCloseTo(10);
    expect(describeSecondsLeft(p.secondsLeft)).toEqual({ key: "e2ee.eta.seconds", n: 10 });
    expect(describeSecondsLeft(400)).toEqual({ key: "e2ee.eta.minutes", n: 7 });
    expect(describeSecondsLeft(2)).toEqual({ key: "e2ee.eta.seconds.few" });
  });

  it("a retried attempt replans on top of what is done; earlier rounds' speed gives the first estimate", () => {
    let now = 0;
    const est = new RoundEstimator({ prior: null, now: () => now });
    est.push({ kind: "start", at: 0 });
    est.push({ kind: "plan", at: 0, direction: "up", files: 10, bytes: 10_000 });
    now = 5000;
    for (let i = 0; i < 10; i++) est.push({ kind: "upload", at: now, path: `p${i}`, bytes: 1000, direction: "up" });
    est.push({ kind: "plan", at: now, direction: "up", files: 2, bytes: 0 });
    expect(est.progress().files).toBe(12);
    est.push({ kind: "done", at: 5000, uploaded: 10, downloaded: 0, deleted: 0, conflicts: 0, held: 0, incomplete: false });
    const next = new RoundEstimator({ now: () => 0 }); // reads the speed saved by the last round
    next.push({ kind: "start", at: 0 });
    next.push({ kind: "plan", at: 0, direction: "up", files: 4, bytes: 4000 });
    expect(next.progress().secondsLeft).toBeCloseTo(2); // 2 files/s and 2 KB/s
  });
});

/* ─── Rules ────────────────────────────────────────────────────────────── */

describe("selective-sync rules", () => {
  it("parses the form and normalises", () => {
    expect(parseRulesForm("Videos/\n /Scans//old/ ,\n..\n", "*.MP4, .mov pdf", "20")).toEqual({ folders: ["Scans/old", "Videos"], extensions: ["mov", "mp4", "pdf"], maxAttachmentBytes: 20 * 1024 * 1024 });
    expect(parseRulesForm("", "", "")).toEqual(NO_RULES);
    expect(normalizeRules({ maxAttachmentBytes: -3 } as never).maxAttachmentBytes).toBeNull();
  });

  it("matches folders exactly (not by prefix), types case-blind, the size only for attachments", () => {
    const ex = compileRules({ folders: ["Video"], extensions: ["MP4"], maxAttachmentBytes: 100 });
    expect(ex("Video/a.md", 1)).toBe("folder:Video");
    expect(ex("Videos/a.md", 1)).toBeNull();
    expect(ex("x/clip.Mp4", 1)).toBe("type:mp4");
    expect(ex("big.md", 1e9)).toBeNull(); // a note is never left out for its size
    expect(ex("big.pdf", 101)).toBe("size:100");
    expect(ex("big.pdf", null)).toBeNull();
  });

  it("are stored per device; unreadable rules stop the round instead of syncing everything", () => {
    expect(loadRules()).toEqual(NO_RULES);
    saveRules({ folders: ["Videos"], extensions: [], maxAttachmentBytes: null });
    expect(loadRules().folders).toEqual(["Videos"]);
    localStorage.setItem("lumen.sync.rules.v1", "{broken");
    expect(() => loadRules()).toThrow(SyncRulesUnreadableError);
    localStorage.setItem("lumen.sync.rules.v1", "[]");
    expect(() => loadRules()).toThrow(SyncRulesUnreadableError);
  });
});

/* ─── Background / resume ──────────────────────────────────────────────── */

describe("background sync within the platform's limits", () => {
  it("says when sync did not run in the background, and why", () => {
    const base = { hiddenAt: 0, now: NOTICE_AFTER_MS + 60_000, lastAt: null, unlocked: true, native: false };
    expect(resumeNotice({ ...base, now: 30_000 })).toBeNull(); // a quick switch
    expect(resumeNotice(base)).toEqual({ key: "e2ee.bg.didNotRun", minutes: 3 });
    expect(resumeNotice({ ...base, native: true })?.key).toBe("e2ee.bg.didNotRunNative");
    expect(resumeNotice({ ...base, lastAt: 1000 })).toBeNull(); // a round finished while away
    expect(resumeNotice({ ...base, unlocked: false })?.key).toBe("e2ee.bg.locked");
  });

  it("starts a round when the app leaves the screen and when it comes back, with the notice", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    let now = 0;
    const syncNow = vi.fn(async () => undefined);
    const notify = vi.fn();
    const off = installBackgroundSync({ unlocked: () => true, lastAt: () => null, syncNow, notify, now: () => now }, doc as unknown as Document);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(syncNow).toHaveBeenCalledTimes(1);
    now = 10 * 60_000;
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(notify).toHaveBeenCalledWith({ key: "e2ee.bg.didNotRun", minutes: 10 });
    expect(syncNow).toHaveBeenCalledTimes(2);
    off();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(syncNow).toHaveBeenCalledTimes(2);
  });
});

/* ─── File tree badges ─────────────────────────────────────────────────── */

describe("file tree badges", () => {
  it("one default rule for every synced row; a rule only for the rows in another state", () => {
    const files = new Map([
      ["a.md", { state: "synced" as const }],
      ["n/b.md", { state: "conflict" as const }],
      ['q"x\\y.md', { state: "pending" as const }],
    ]);
    const css = badgeCss(files, folderStates(files));
    expect(css.split("\n")).toHaveLength(4); // default + n/b.md + folder n + the quoted one
    expect(css).toContain('[data-path="n"]::after');
    expect(css).toContain(`[data-path=${cssString('q"x\\y.md')}]`);
    expect(cssString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\a d"');
    expect(css).toContain('/ "Conflict"');
  });

  it("is applied to the page while unlocked and removed after", () => {
    applyTreeBadges(new Map([["a.md", { state: "error" as const }]]), new Map());
    expect(document.body.dataset.lumenSync).toBe("on");
    expect(document.getElementById("lumen-sync-badges")?.textContent).toContain('[data-path="a.md"]');
    clearTreeBadges();
    expect(document.body.dataset.lumenSync).toBeUndefined();
    expect(document.getElementById("lumen-sync-badges")).toBeNull();
  });
});

/* ─── Session and panel ────────────────────────────────────────────────── */

describe("session and activity panel", () => {
  const URL_ = "https://dav.example/remote.php/dav/files/tal/Lumen/";
  const webdav: ProviderSettings = { kind: "webdav", url: URL_, username: "tal" };
  const kv = new Map<string, unknown>();
  beforeEach(() => {
    kv.clear();
    __setProviderStore({ get: async <T,>(k: string) => kv.get(k) as T | undefined, set: async (k, v) => void kv.set(k, v), del: async (k) => void kv.delete(k) });
  });
  afterEach(() => {
    __setProviderStore(null);
    __resetSecretStore();
    clearTreeBadges();
  });

  function lab() {
    const server = fakeWebdav({ baseUrl: URL_, username: "tal", password: "pw" });
    const listeners = new Set<(e: { type: string; path: string }) => void>();
    const device = (resolver: ConflictResolver = keepBothResolver) => {
      const files = memoryFiles();
      const session = createSession({
        fetch: fakeFetch(server.handle),
        local: () => files,
        store: async () => memoryStateStore(),
        resolver,
        pbkdf2Iterations: TEST_ITERATIONS,
        kdfPolicy: { minPbkdf2Iterations: TEST_ITERATIONS },
        intervalMinutes: 0,
        background: false,
        watch: (l) => (listeners.add(l), () => listeners.delete(l)),
      });
      return { files, session };
    };
    return { server, device, emit: (e: { type: string; path: string }) => listeners.forEach((l) => l(e)) };
  }

  it("publishes every file's state and the tree badges after a round; a local edit shows pending at once", async () => {
    const { device, emit } = lab();
    const a = device();
    await a.files.write("notes/a.md", text("a"), null);
    await a.session.connect(webdav, "pw");
    await a.session.open(PASSPHRASE);
    expect(a.session.get().files?.get("notes/a.md")).toEqual({ state: "synced" });
    expect(document.body.dataset.lumenSync).toBe("on");
    emit({ type: "write", path: "notes/a.md" });
    expect(a.session.get().files?.get("notes/a.md")).toEqual({ state: "pending", direction: "up" });
    expect(a.session.get().folders?.get("notes")).toBe("pending");
    expect(document.getElementById("lumen-sync-badges")?.textContent).toContain('[data-path="notes/a.md"]');
    a.session.lock();
    expect(document.body.dataset.lumenSync).toBeUndefined();
  });

  it("unreadable rules stop the round with a message; saved rules apply from the next round", async () => {
    const { device } = lab();
    const a = device();
    await a.files.write("Videos/clip.mp4", bytes(1000), null);
    await a.files.write("n.md", text("n"), null);
    await a.session.connect(webdav, "pw");
    localStorage.setItem("lumen.sync.rules.v1", "{broken");
    await expect(a.session.open(PASSPHRASE)).rejects.toBeInstanceOf(SyncRulesUnreadableError);
    expect(a.session.get().error).toMatch(/can't be read/);
    a.session.setRules({ folders: ["Videos"], extensions: [], maxAttachmentBytes: null });
    const r = await a.session.syncNow();
    expect(r.uploaded).toBe(1);
    // Only n.md's blob besides the header and the manifest: the video's 1,000 bytes never went out.
    for (const f of server.files.values()) expect(f.data.length).toBeLessThan(1000);
    expect(a.session.get().files?.get("Videos/clip.mp4")?.state).toBe("excluded");
    expect(a.session.activity.list().some((e) => e.kind === "excluded" && e.path === "Videos/clip.mp4")).toBe(true);
  });

  it("the activity panel shows a conflict while its dialog is still open", async () => {
    const { device } = lab();
    const a = device();
    await a.files.write("shared.md", text("base"), null);
    await a.session.connect(webdav, "pw");
    await a.session.open(PASSPHRASE);
    let decide: (r: ConflictResolution) => void = () => undefined;
    const b = device(
      () =>
        new Promise<ConflictResolution>((res) => {
          decide = res;
        }),
    );
    await b.session.connect(webdav, null);
    await b.session.open(PASSPHRASE);
    await a.files.write("shared.md", text("from A"), (await a.files.list()).find((f) => f.path === "shared.md")!.hash);
    await a.session.syncNow();
    await b.files.write("shared.md", text("from B"), (await b.files.list()).find((f) => f.path === "shared.md")!.hash);
    render(<SyncActivity session={b.session} />);
    const round = b.session.syncNow();
    await waitFor(() => expect(screen.getByTestId("sync-activity").textContent).toContain("Conflict: shared.md"), { timeout: 5000 });
    decide({ kind: "keepBoth" });
    await round;
    await waitFor(() => expect(screen.getByTestId("sync-activity").textContent).toMatch(/Sync finished: \d+ up, 1 down/));
  });
});

/* ─── Benchmark, scaled down (the full one: npm run bench:sync) ────────── */

describe("benchmark, scaled down: first sync and one change through the WebDAV provider", () => {
  it("500 notes + 4 MB of attachments sync; one changed note goes up and comes down in under 3 s each", async () => {
    const { webdavProvider } = await import("../sync/e2ee/providers/webdav");
    const URL_ = "https://dav.example/bench/";
    const server = fakeWebdav({ baseUrl: URL_, username: "u", password: "p", preCreated: true });
    const dav = () => webdavProvider({ url: URL_, username: "u", password: "p" }, { fetch: fakeFetch(server.handle) });
    const a = await newVault(dav());
    for (let i = 0; i < 500; i++) a.files.set(`notes/n${i}.md`, `# פתק ${i}\n\n${"שורה ".repeat(200)}`);
    for (let i = 0; i < 4; i++) a.files.files.set(`att/f${i}.bin`, bytes(1024 * 1024, i));
    expect((await a.sync.sync()).uploaded).toBe(504);
    const b = await joinVault("B", dav());
    expect((await b.sync.sync()).downloaded).toBe(504);
    a.files.set("notes/n1.md", "# edited");
    let t0 = performance.now();
    expect((await a.sync.sync()).uploaded).toBe(1);
    expect(performance.now() - t0).toBeLessThan(3000);
    t0 = performance.now();
    expect((await b.sync.sync()).downloaded).toBe(1);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(b.files.text("notes/n1.md")).toBe("# edited");
  }, 60_000);
});
