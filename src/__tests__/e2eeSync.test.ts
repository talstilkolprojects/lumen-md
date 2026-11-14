/**
 * Encrypted sync (plan 3.4) over the simulated provider folder: two devices,
 * what the provider sees, rollback / replay, pairing and TOFU, the CAS race,
 * interruption mid-way, conflicts through the ConflictDialog, garbage.
 */

import { describe, it, expect, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { memoryProvider, PreconditionFailedError, ProviderUnavailableError, type SyncProvider } from "../sync/e2ee/provider";
import { HEADER_NAME } from "../sync/e2ee/header";
import { manifestName, openManifest, sealManifest, RollbackError, checkFreshness, blobName, HISTORY_LENGTH } from "../sync/e2ee/manifest";
import { SEALED_FORMAT, DecryptError } from "../sync/e2ee/keys";
import { createVault, unlockVault, NoVaultError, VaultExistsError, E2eeSync } from "../sync/e2ee/engine";
import { idbStateStore, memoryStateStore } from "../sync/e2ee/state";
import { PairingError, PAIRING_TTL_MS } from "../sync/e2ee/pairing";
import { WrongPassphraseError } from "../sync/e2ee/header";
import { dialogResolver, keepBothResolver, conflictCopyPath, asText, type ConflictResolver } from "../sync/e2ee/conflict";
import { isSyncedPath, vaultLocalFiles } from "../sync/e2ee/localFiles";
import { createMemoryBackend } from "../storage/vault/memory";
import { VaultError, type VaultBackend } from "../storage/vault/types";
import { utf8 } from "../sync/e2ee/bytes";
import { device, joinVault, newVault, PASSPHRASE, snapshot, TEST_ITERATIONS, TEST_POLICY } from "./helpers/e2ee";

/** True when `needle` occurs in `hay` as a byte sequence. */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("e2ee sync: two devices", () => {
  it("creates, joins, and syncs edits and deletions both ways", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("a.md", "# A");
    a.files.set("notes/שלום.md", "שלום עולם");
    const r1 = await a.sync.sync();
    expect(r1).toMatchObject({ uploaded: 2, counter: 2, incomplete: false });

    const b = await joinVault("B", provider);
    expect((await b.sync.sync()).downloaded).toBe(2);
    expect(snapshot(b)).toEqual(snapshot(a));

    b.files.set("a.md", "# A, edited on B");
    b.files.delete("notes/שלום.md");
    b.files.set("b.md", "new");
    expect(await b.sync.sync()).toMatchObject({ uploaded: 2, deleted: 1 });
    expect(await a.sync.sync()).toMatchObject({ downloaded: 2, deleted: 1, conflicts: [] });
    expect(snapshot(a)).toEqual([
      ["a.md", "# A, edited on B"],
      ["b.md", "new"],
    ]);
    // A round with nothing to do writes nothing.
    const counter = (await a.sync.sync()).counter;
    expect((await b.sync.sync()).counter).toBe(counter);
  });

  it("refuses a second vault, a missing vault and a wrong passphrase", async () => {
    const provider = memoryProvider();
    await newVault(provider);
    await expect(createVault(provider, "x", { pbkdf2Iterations: TEST_ITERATIONS })).rejects.toBeInstanceOf(VaultExistsError);
    await expect(unlockVault(memoryProvider(), PASSPHRASE, TEST_POLICY)).rejects.toBeInstanceOf(NoVaultError);
    await expect(unlockVault(provider, "not it", TEST_POLICY)).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("syncs hidden repository content but not the trash or git internals", async () => {
    expect(isSyncedPath("notes/a.md")).toBe(true);
    expect(isSyncedPath(".github/workflows/ci.yml")).toBe(true);
    expect(isSyncedPath(".gitignore")).toBe(true);
    expect(isSyncedPath("notes/.trash/a.md")).toBe(true);
    expect(isSyncedPath(".trash/a.md")).toBe(false);
    expect(isSyncedPath(".git/HEAD")).toBe(false);
    expect(isSyncedPath("a/../b")).toBe(false);
    expect(isSyncedPath("./b")).toBe(false);
    expect(isSyncedPath("a//b")).toBe(false);
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set(".trash/old.md", "gone");
    a.files.set(".git/HEAD", "ref: refs/heads/main");
    a.files.set(".github/ci.yml", "on: push");
    a.files.set("n.md", "x");
    expect((await a.sync.sync()).uploaded).toBe(2);
    const b = await joinVault("B", provider);
    await b.sync.sync();
    expect(snapshot(b).map(([p]) => p)).toEqual([".github/ci.yml", "n.md"]);
  });
});

describe("e2ee sync: what the provider sees", () => {
  it("only ciphertext and opaque names — no paths, contents, versions or counter", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    const b = await joinVault("B", provider);
    const texts: Record<string, string> = {
      "projects/תוכנית סודית.md": "# תוכנית\nפגישה עם הספק ביום שלישי",
      "secret-plan.md": "launch codes: hunter2",
      "notes/2026/october.md": "counter version manifest",
    };
    const manifestNames = new Set<string>();
    for (let round = 0; round < 5; round++) {
      for (const [p, t] of Object.entries(texts)) (round % 2 ? a : b).files.set(p, `${t} — round ${round}`);
      await a.sync.sync();
      await b.sync.sync();
      manifestNames.add(await manifestName(a.keys));
    }
    // The manifest keeps one name across every version: its name says nothing about the version.
    expect(manifestNames.size).toBe(1);

    const needles = [
      ...Object.keys(texts),
      ...Object.keys(texts).flatMap((p) => p.split("/")),
      ...Object.values(texts),
      "round",
      '"counter"',
      '"ver"',
      '"files"',
      "manifest",
    ].map(utf8);
    for (const [name, obj] of provider.objects) {
      if (name === HEADER_NAME) {
        const header = JSON.parse(new TextDecoder().decode(obj.data)) as Record<string, unknown>;
        expect(Object.keys(header).sort()).toEqual(["format", "kdf", "mac", "protocol", "vaultId"]);
        for (const n of needles) expect(contains(obj.data, n)).toBe(false);
        continue;
      }
      expect(name).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const n of needles) expect(contains(utf8(name), n)).toBe(false);
      expect(obj.data[0]).toBe(SEALED_FORMAT);
      // nonce + tag + a padded plaintext: the exact size is hidden in a 256-byte bucket.
      expect((obj.data.length - 1 - 12 - 16) % 256).toBe(0);
      for (const n of needles) expect(contains(obj.data, n)).toBe(false);
    }
  });
});

describe("e2ee sync: rollback and replay", () => {
  it("rejects an old manifest the provider serves again, and a vanished one", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    const name = await manifestName(a.keys);
    a.files.set("a.md", "v1");
    await a.sync.sync();
    const old = provider.objects.get(name)!;
    a.files.set("a.md", "v2");
    await a.sync.sync();

    provider.objects.set(name, { ...old, etag: "replayed" });
    const err = await a.sync.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RollbackError);
    expect(err).toMatchObject({ kind: "older", seen: 3, got: 2 });
    // Nothing was applied: the device keeps its newer text.
    expect(a.files.text("a.md")).toBe("v2");

    provider.objects.delete(name);
    await expect(a.sync.sync()).rejects.toMatchObject({ kind: "older", got: 0 });
  });

  it("rejects a different manifest with the same counter (fork) and a forged one", async () => {
    expect(() => checkFreshness({ counter: 5, digest: "a" }, { counter: 5, digest: "b" })).toThrow(RollbackError);
    expect(() => checkFreshness({ counter: 5, digest: "a" }, { counter: 6, digest: "b" })).not.toThrow();
    expect(() => checkFreshness(null, { counter: 1, digest: "b" })).not.toThrow();

    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("a.md", "x");
    await a.sync.sync();
    const name = await manifestName(a.keys);
    const { manifest } = await openManifest(a.keys, provider.objects.get(name)!.data);
    const fork = await sealManifest(a.keys, { ...manifest, files: {} });
    provider.objects.set(name, { data: fork.bytes, etag: "fork" });
    await expect(a.sync.sync()).rejects.toMatchObject({ kind: "fork" });

    // A provider without the key cannot produce a manifest at all.
    const garbage = provider.objects.get(name)!.data.slice();
    garbage[30] ^= 0xff;
    provider.objects.set(name, { data: garbage, etag: "x" });
    await expect(a.sync.sync()).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a blob swapped for another one", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("a.md", "AAA");
    a.files.set("b.md", "BBB");
    await a.sync.sync();
    const { manifest } = await openManifest(a.keys, provider.objects.get(await manifestName(a.keys))!.data);
    const na = await blobName(a.keys, "a.md", manifest.files["a.md"].rev);
    const nb = await blobName(a.keys, "b.md", manifest.files["b.md"].rev);
    provider.objects.set(na, provider.objects.get(nb)!);
    const b = await joinVault("B", provider);
    await expect(b.sync.sync()).rejects.toBeInstanceOf(DecryptError);
  });
});

describe("e2ee sync: anchoring a new device (pairing / TOFU)", () => {
  /** A vault at counter 4 whose counter-3 manifest was saved by the provider for a replay. */
  async function replaySetup() {
    const provider = memoryProvider();
    const a = await newVault(provider);
    const name = await manifestName(a.keys);
    a.files.set("a.md", "first");
    await a.sync.sync();
    a.files.set("b.md", "second");
    await a.sync.sync();
    const old = provider.objects.get(name)!; // counter 3: a.md + b.md
    a.files.set("c.md", "third — the newest state");
    expect((await a.sync.sync()).counter).toBe(4);
    const current = provider.objects.get(name)!;
    return { provider, a, name, old, current };
  }

  it("after pairing, a new device rejects the old manifest", async () => {
    const { provider, a, name, old } = await replaySetup();
    const code = await a.sync.pairingCode();
    expect(code).toMatch(/^lumen-pair:1:[A-Za-z0-9_-]+$/);

    const c = await joinVault("C", provider);
    await c.sync.pair(code);
    expect(await c.sync.freshness()).toEqual({ source: "paired", verified: true, counter: 4 });
    provider.objects.set(name, { ...old, etag: "replayed" });
    await expect(c.sync.sync()).rejects.toMatchObject({ kind: "older", seen: 4, got: 3 });
    expect(c.files.files.size).toBe(0);
  });

  it("without pairing, the old manifest is accepted but freshness stays unverified (no protection claimed)", async () => {
    const { provider, name, old, current } = await replaySetup();
    provider.objects.set(name, { ...old, etag: "replayed" });
    const d = await joinVault("D", provider);
    await d.sync.sync();
    expect(snapshot(d).map(([p]) => p)).toEqual(["a.md", "b.md"]); // the replayed, stale state
    expect(await d.sync.freshness()).toEqual({ source: "unverified", verified: false, counter: 3 });

    // From here on, the device does refuse anything older than what it saw.
    provider.objects.set(name, current);
    await d.sync.sync();
    expect(d.files.text("c.md")).toBe("third — the newest state");
    provider.objects.set(name, { ...old, etag: "again" });
    await expect(d.sync.sync()).rejects.toBeInstanceOf(RollbackError);

    await d.sync.confirmFreshness();
    expect(await d.sync.freshness()).toMatchObject({ source: "confirmed", verified: true });
  });

  it("an older pairing code never lowers the anchor nor verifies a newer state", async () => {
    const { provider, a, name, old } = await replaySetup();
    const staleCode = await a.sync.pairingCode(); // made when A was at counter 4 …
    a.files.set("d.md", "fifth");
    await a.sync.sync(); // counter 5
    const d = await joinVault("D", provider);
    await d.sync.sync(); // TOFU at 5
    // … cannot vouch for D's newer state: refused, D stays unverified at 5.
    await expect(d.sync.pair(staleCode)).rejects.toThrow(/older than this device/);
    expect(await d.sync.freshness()).toEqual({ source: "unverified", verified: false, counter: 5 });
    await d.sync.pair(await a.sync.pairingCode()); // a current code does
    expect(await d.sync.freshness()).toEqual({ source: "paired", verified: true, counter: 5 });
    // A verified device ignores an old code: nothing changes.
    await d.sync.pair(staleCode);
    expect(await d.sync.freshness()).toEqual({ source: "paired", verified: true, counter: 5 });
    provider.objects.set(name, { ...old, etag: "replayed" });
    await expect(d.sync.sync()).rejects.toBeInstanceOf(RollbackError);
  });

  it("refuses damaged, altered, foreign and expired pairing codes", async () => {
    let now = 1_800_000_000_000;
    const provider = memoryProvider();
    const a = await newVault(provider);
    await a.sync.sync();
    const code = await a.sync.pairingCode();
    const c = await joinVault("C", provider, undefined, () => now);
    await expect(c.sync.pair("hello")).rejects.toBeInstanceOf(PairingError);
    await expect(c.sync.pair("lumen-pair:1:@@@")).rejects.toBeInstanceOf(PairingError);
    await expect(c.sync.pair("lumen-pair:1:AAAA")).rejects.toBeInstanceOf(PairingError);
    const altered = code.slice(0, -3) + (code.endsWith("A") ? "BBB" : "AAA");
    await expect(c.sync.pair(altered)).rejects.toBeInstanceOf(PairingError);

    const other = await newVault(memoryProvider());
    await other.sync.sync();
    await expect(c.sync.pair(await other.sync.pairingCode())).rejects.toBeInstanceOf(PairingError);

    const timed = device("T", provider, a.keys, undefined, () => now);
    await timed.sync.sync();
    // An unverified (TOFU) device must not vouch for a state nobody verified.
    await expect(timed.sync.pairingCode()).rejects.toBeInstanceOf(PairingError);
    await timed.sync.confirmFreshness();
    const fresh = await timed.sync.pairingCode();
    now += PAIRING_TTL_MS + 1;
    await expect(c.sync.pair(fresh)).rejects.toThrow(/expired/);
    expect(await c.sync.freshness()).toMatchObject({ source: "unverified", verified: false, counter: null });
    await expect(c.sync.confirmFreshness()).rejects.toThrow();
    await expect(c.sync.pairingCode()).rejects.toThrow();
  });
});

describe("e2ee sync: conditional manifest writes (CAS)", () => {
  /** Holds every manifest write until `n` manifest reads happened: both devices start from version N. */
  function gatedProvider(n: number): SyncProvider & { manifest?: string; inner: ReturnType<typeof memoryProvider> } {
    const inner = memoryProvider();
    let reads = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const p = {
      id: "gated",
      inner,
      manifest: undefined as string | undefined,
      get: async (name: string) => {
        const o = await inner.get(name);
        if (name === p.manifest && ++reads >= n) open();
        return o;
      },
      put: async (name: string, data: Uint8Array, cond?: Parameters<SyncProvider["put"]>[2]) => {
        if (name === p.manifest) await gate;
        return inner.put(name, data, cond);
      },
      delete: (name: string) => inner.delete(name),
      list: () => inner.list(),
    };
    return p;
  }

  it("the provider refuses a stale etag", async () => {
    const p = memoryProvider();
    const { etag } = await p.put("x", utf8("1"));
    await p.put("x", utf8("2"), { ifMatch: etag });
    await expect(p.put("x", utf8("3"), { ifMatch: etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(p.put("x", utf8("3"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(await p.list()).toEqual(["x"]);
    await p.delete("x");
    expect(await p.get("x")).toBeNull();
  });

  it("two devices writing in parallel from the same version N: both changes are kept", async () => {
    const provider = gatedProvider(2);
    const a = await newVault(provider);
    a.files.set("shared.md", "base");
    await a.sync.sync();
    const b = await joinVault("B", provider);
    await b.sync.sync();
    const mname = await manifestName(a.keys);
    provider.manifest = mname;
    const n = (await openManifest(a.keys, provider.inner.objects.get(mname)!.data)).manifest.counter;

    a.files.set("from-a.md", "A's note");
    b.files.set("from-b.md", "B's note");
    const [ra, rb] = await Promise.all([a.sync.sync(), b.sync.sync()]);
    expect(ra.retries + rb.retries).toBe(1); // exactly one lost the race, pulled, merged and retried
    expect(Math.max(ra.counter, rb.counter)).toBe(n + 2);
    await a.sync.sync();
    await b.sync.sync();
    for (const d of [a, b]) {
      expect(snapshot(d)).toEqual([
        ["from-a.md", "A's note"],
        ["from-b.md", "B's note"],
        ["shared.md", "base"],
      ]);
    }
  });

  it("both edit the same note from version N: the loser merges and both edits survive", async () => {
    const merged: string[] = [];
    const union: ConflictResolver = async (c) => {
      const text = `${asText(c.local)}\n${asText(c.remote)}`;
      merged.push(c.path);
      return { kind: "content", data: utf8(text) };
    };
    const provider = gatedProvider(2);
    const a = await newVault(provider, union);
    a.files.set("shared.md", "base");
    await a.sync.sync();
    const b = await joinVault("B", provider, union);
    await b.sync.sync();
    provider.manifest = await manifestName(a.keys);
    a.files.set("shared.md", "edit from A");
    b.files.set("shared.md", "edit from B");
    await Promise.all([a.sync.sync(), b.sync.sync()]);
    await a.sync.sync();
    await b.sync.sync();
    expect(merged).toEqual(["shared.md"]);
    expect(a.files.text("shared.md")).toBe(b.files.text("shared.md"));
    expect(a.files.text("shared.md")).toContain("edit from A");
    expect(a.files.text("shared.md")).toContain("edit from B");
  });

  it("gives up without loss after too many lost races, and finishes on the next round", async () => {
    const inner = memoryProvider();
    let manifest = "";
    let losses = 0;
    const flaky: SyncProvider = {
      id: "flaky",
      get: (n) => inner.get(n),
      put: async (n, d, c) => {
        if (n === manifest && losses-- > 0) throw new PreconditionFailedError(n);
        return inner.put(n, d, c);
      },
      delete: (n) => inner.delete(n),
      list: () => inner.list(),
    };
    const a = await newVault(flaky);
    manifest = await manifestName(a.keys);
    losses = 8;
    a.files.set("x.md", "x");
    expect(await a.sync.sync()).toMatchObject({ incomplete: true, retries: 8 });
    expect(await a.sync.sync()).toMatchObject({ incomplete: false, uploaded: 1 });
    const b = await joinVault("B", flaky);
    await b.sync.sync();
    expect(b.files.text("x.md")).toBe("x");
    // The blobs of the lost attempts were cleaned up: header + manifest + one blob.
    expect(inner.objects.size).toBe(3);
  });
});

describe("e2ee sync: interruption mid-way", () => {
  function faultyProvider() {
    let plan: ((op: string, name: string, phase: string) => boolean) | null = null;
    const provider = memoryProvider({
      fault: (op, name, phase) => {
        if (plan?.(op, name, phase)) {
          plan = null;
          throw new ProviderUnavailableError();
        }
      },
    });
    return { provider, failOnce: (f: (op: string, name: string, phase: string) => boolean) => (plan = f) };
  }

  it("a manifest write whose answer was lost is recognised on the next round", async () => {
    const { provider, failOnce } = faultyProvider();
    const a = await newVault(provider);
    const m = await manifestName(a.keys);
    a.files.set("a.md", "hello");
    failOnce((op, name, phase) => op === "put" && name === m && phase === "after");
    await expect(a.sync.sync()).rejects.toBeInstanceOf(ProviderUnavailableError);
    // The write did happen; the next round finds its own change there and uploads nothing.
    expect(await a.sync.sync()).toMatchObject({ uploaded: 0, counter: 2 });
    const b = await joinVault("B", provider);
    await b.sync.sync();
    expect(b.files.text("a.md")).toBe("hello");
    expect(provider.objects.size).toBe(3);
  });

  it("blobs uploaded before a failed manifest write are reused or cleaned, never lost", async () => {
    const { provider, failOnce } = faultyProvider();
    const a = await newVault(provider);
    const m = await manifestName(a.keys);
    a.files.set("a.md", "1");
    a.files.set("b.md", "2");
    failOnce((op, name, phase) => op === "put" && name === m && phase === "before");
    await expect(a.sync.sync()).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(provider.objects.size).toBe(4); // header, manifest, two orphan blobs
    a.files.set("b.md", "2, edited after the failure");
    expect(await a.sync.sync()).toMatchObject({ uploaded: 2 });
    expect(provider.objects.size).toBe(4); // header, manifest, two live blobs: the orphans are gone
    const b = await joinVault("B", provider);
    await b.sync.sync();
    expect(snapshot(b)).toEqual(snapshot(a));
  });

  it("a download cut off half way resumes where it stopped", async () => {
    const { provider, failOnce } = faultyProvider();
    const a = await newVault(provider);
    for (let i = 0; i < 6; i++) a.files.set(`n${i}.md`, `note ${i}`);
    await a.sync.sync();
    const b = await joinVault("B", provider);
    let gets = 0;
    failOnce((op, name, phase) => op === "get" && name !== HEADER_NAME && phase === "before" && ++gets === 4);
    await expect(b.sync.sync()).rejects.toBeInstanceOf(ProviderUnavailableError);
    const half = b.files.files.size;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(6);
    const r = await b.sync.sync();
    expect(r.downloaded).toBe(6 - half);
    expect(snapshot(b)).toEqual(snapshot(a));
  });

  it("a local edit made while the round runs is not overwritten", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("a.md", "v1");
    await a.sync.sync();
    const b = await joinVault("B", provider);
    await b.sync.sync();
    a.files.set("a.md", "v2 from A");
    await a.sync.sync();
    // B's write-back finds the file changed under it, so it holds the path instead.
    const write = b.files.write.bind(b.files);
    b.files.write = async (p, d, want) => {
      b.files.set(p, "typed on B meanwhile");
      return write(p, d, want);
    };
    expect((await b.sync.sync()).held).toEqual(["a.md"]);
    b.files.write = write;
    expect(b.files.text("a.md")).toBe("typed on B meanwhile");
    const r = await b.sync.sync(); // now a real conflict: keep both
    expect(r.conflicts).toEqual(["a.md"]);
    expect(snapshot(b).map(([, t]) => t).sort()).toEqual(["typed on B meanwhile", "v2 from A"]);
  });
});

describe("e2ee sync: conflicts", () => {
  async function conflicted(resolver: ConflictResolver, local = "line 1\nfrom B", remote = "line 1\nfrom A") {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("note.md", "line 1");
    await a.sync.sync();
    const b = await joinVault("B", provider, resolver, () => Date.UTC(2026, 9, 20));
    await b.sync.sync();
    a.files.set("note.md", remote);
    await a.sync.sync();
    b.files.set("note.md", local);
    return { a, b, provider };
  }

  it("opens the three-way ConflictDialog with base, mine and theirs; a merge keeping both is pushed", async () => {
    const { a, b } = await conflicted(dialogResolver);
    const round = b.sync.sync();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("note.md");
    expect(dialog.textContent).toContain("from A");
    expect(dialog.textContent).toContain("from B");
    fireEvent.click(screen.getByLabelText("both"));
    fireEvent.click(screen.getByText("Apply merge"));
    const r = await round;
    expect(r.conflicts).toEqual(["note.md"]);
    expect(b.files.text("note.md")).toContain("from A");
    expect(b.files.text("note.md")).toContain("from B");
    await a.sync.sync();
    expect(a.files.text("note.md")).toBe(b.files.text("note.md"));
  });

  it("cancelling the dialog holds the note: nothing changes on either side", async () => {
    const { a, b } = await conflicted(dialogResolver);
    const round = b.sync.sync();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByText("Decide later"));
    expect((await round).held).toEqual(["note.md"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(b.files.text("note.md")).toBe("line 1\nfrom B");
    await a.sync.sync();
    expect(a.files.text("note.md")).toBe("line 1\nfrom A");
  });

  it("taking theirs or mine from the dialog", async () => {
    const one = await conflicted(dialogResolver);
    let round = one.b.sync.sync();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByText("Take theirs"));
    await round;
    expect(one.b.files.text("note.md")).toBe("line 1\nfrom A");

    const two = await conflicted(dialogResolver);
    round = two.b.sync.sync();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getAllByText("Keep mine")[0]);
    await round;
    await two.a.sync.sync();
    expect(two.a.files.text("note.md")).toBe("line 1\nfrom B");
  });

  it("binary files and the headless default keep both versions as a conflict copy", async () => {
    const bin = String.fromCharCode(0) + "binary";
    for (const resolver of [dialogResolver, keepBothResolver]) {
      const { a, b } = await conflicted(resolver, `${bin} B`, `${bin} A`);
      await b.sync.sync();
      await a.sync.sync();
      const paths = snapshot(a).map(([p]) => p);
      expect(paths).toEqual(["note (conflict 2026-10-20 " + paths[0].slice(26, 30) + ").md", "note.md"]);
      expect(snapshot(a)).toEqual(snapshot(b));
      expect(snapshot(a).map(([, t]) => t).sort()).toEqual([`${bin} A`, `${bin} B`]);
    }
  });

  it("an edit wins over a concurrent deletion, on both sides", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("x.md", "x");
    a.files.set("y.md", "y");
    await a.sync.sync();
    const b = await joinVault("B", provider);
    await b.sync.sync();
    a.files.delete("x.md");
    a.files.set("y.md", "y edited on A");
    await a.sync.sync();
    b.files.set("x.md", "x edited on B");
    b.files.delete("y.md");
    const r = await b.sync.sync();
    expect(r.conflicts.sort()).toEqual(["x.md", "y.md"]);
    await a.sync.sync();
    for (const d of [a, b]) {
      expect(snapshot(d)).toEqual([
        ["x.md", "x edited on B"],
        ["y.md", "y edited on A"],
      ]);
    }
  });

  it("names conflict copies next to the original and avoids taken names", () => {
    const taken = new Set(["d/a (conflict t).md"]);
    expect(conflictCopyPath("d/a.md", "t", (p) => taken.has(p))).toBe("d/a (conflict t 2).md");
    expect(conflictCopyPath("README", "t", () => false)).toBe("README (conflict t)");
    expect(conflictCopyPath(".env", "t", () => false)).toBe(".env (conflict t)");
  });
});

describe("e2ee sync: the vault as the local side", () => {
  it("syncs a VaultBackend folder tree, skipping the trash", async () => {
    const provider = memoryProvider();
    const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const vault = createMemoryBackend();
    await vault.write("notes/a.md", "# A");
    await vault.write("img/x.bin", new Uint8Array([0, 1, 2, 255]));
    await vault.write(".trash/old.md", "gone");
    const a = device("A", provider, keys);
    const sa = new E2eeSync({ provider, keys, local: vaultLocalFiles(vault), store: memoryStateStore() });
    await sa.markCreated(anchor);
    expect((await sa.sync()).uploaded).toBe(2);
    await a.sync.sync();
    expect(a.files.text("notes/a.md")).toBe("# A");
    expect([...a.files.files.get("img/x.bin")!]).toEqual([0, 1, 2, 255]);
    a.files.set("notes/a.md", "# A from the other device");
    a.files.delete("img/x.bin");
    await a.sync.sync();
    await sa.sync();
    expect(await vault.readText("notes/a.md")).toBe("# A from the other device");
    expect(await vault.stat("img/x.bin")).toBeNull();
    expect(await vault.readText(".trash/old.md")).toBe("gone");
    const local = vaultLocalFiles(vault);
    expect(await local.read("nope.md")).toBeNull();
    expect(await local.write("notes/a.md", utf8("x"), "not-the-hash")).toBe(false);
    expect(await local.remove("notes/a.md", "not-the-hash")).toBe(false);
  });

  it("keeps device state in IndexedDB", async () => {
    const s = await idbStateStore("test-vault");
    expect(await s.load()).toBeNull();
    await s.save({ deviceId: "d", anchor: { counter: 3, digest: "x" }, freshness: "paired", base: {}, pending: [] });
    expect((await s.load())?.anchor).toEqual({ counter: 3, digest: "x" });
    await s.setBase("a.md", utf8("base"));
    expect(new TextDecoder().decode((await s.getBase("a.md"))!)).toBe("base");
    await s.setBase("a.md", null);
    expect(await s.getBase("a.md")).toBeNull();
  });
});

describe("e2ee sync: edge cases", () => {
  it("a device that trusted a replayed manifest is raised by a newer pairing code", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    const name = await manifestName(a.keys);
    a.files.set("a.md", "1");
    await a.sync.sync();
    const old = provider.objects.get(name)!; // counter 2
    a.files.set("b.md", "2");
    await a.sync.sync(); // counter 3
    const current = provider.objects.get(name)!;

    provider.objects.set(name, { ...old, etag: "replayed" });
    const d = await joinVault("D", provider);
    await d.sync.sync();
    expect(await d.sync.freshness()).toMatchObject({ source: "unverified", counter: 2 });
    await d.sync.pair(await a.sync.pairingCode());
    expect(await d.sync.freshness()).toEqual({ source: "paired", verified: true, counter: 3 });
    await expect(d.sync.sync()).rejects.toMatchObject({ kind: "older", seen: 3, got: 2 });
    provider.objects.set(name, current);
    await d.sync.sync();
    expect(snapshot(d)).toEqual(snapshot(a));

    // A code for the same counter but another manifest is a fork.
    const { manifest } = await openManifest(a.keys, current.data);
    const fake = await sealManifest(a.keys, { ...manifest, files: {} });
    const f2 = await joinVault("F2", provider);
    provider.objects.set(name, { data: fake.bytes, etag: "fake" });
    await f2.sync.sync();
    provider.objects.set(name, current);
    await expect(f2.sync.pair(await a.sync.pairingCode())).rejects.toMatchObject({ kind: "fork" });
  });

  it("creation interrupted after the header resumes on retry; a vault with data is never taken over", async () => {
    for (const phase of ["after", "before"] as const) {
      let failManifestPut = true;
      let header = "";
      const provider = memoryProvider({
        fault: (op, name, ph) => {
          if (op !== "put") return;
          if (phase === "after" && name === HEADER_NAME && ph === "after" && !header) {
            header = name;
            throw new ProviderUnavailableError();
          }
          if (phase === "before" && name !== HEADER_NAME && ph === "before" && failManifestPut) {
            failManifestPut = false;
            throw new ProviderUnavailableError();
          }
        },
      });
      await expect(createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS })).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
      expect(anchor.counter).toBe(1);
      const a = device("A", provider, keys);
      await a.sync.markCreated(anchor);
      a.files.set("x.md", "x");
      await a.sync.sync();
      await expect(createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS })).rejects.toBeInstanceOf(
        VaultExistsError,
      );
    }
  });

  it("syncs notes named like Object.prototype members", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    for (const p of ["__proto__", "constructor", "notes/toString", "hasOwnProperty.md"]) a.files.set(p, `content of ${p}`);
    expect((await a.sync.sync()).uploaded).toBe(4);
    expect((await a.sync.sync()).uploaded).toBe(0);
    const b = await joinVault("B", provider);
    expect((await b.sync.sync()).downloaded).toBe(4);
    expect(snapshot(b)).toEqual(snapshot(a));
    b.files.set("__proto__", "edited");
    await b.sync.sync();
    await a.sync.sync();
    expect(a.files.text("__proto__")).toBe("edited");
  });

  it("hands the merge the stored ancestor only when it is the version the base names", async () => {
    const seen: Array<string | null> = [];
    const record: ConflictResolver = async (c) => {
      seen.push(c.base ? new TextDecoder().decode(c.base) : null);
      return { kind: "local" };
    };
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("n.md", "ancestor");
    await a.sync.sync();
    const b = await joinVault("B", provider, record);
    await b.sync.sync();
    for (const tamper of [false, true]) {
      a.files.set("n.md", `A ${tamper}`);
      await a.sync.sync();
      b.files.set("n.md", `B ${tamper}`);
      // An interruption between saving the bytes and the metadata leaves other bytes behind.
      if (tamper) await b.store.setBase("n.md", utf8("not the ancestor"));
      await b.sync.sync();
    }
    expect(seen).toEqual(["ancestor", null]);
  });

  it("keeps garbage names until their delete succeeded", async () => {
    let failDeletes = 0;
    const provider = memoryProvider({
      fault: (op, _n, phase) => {
        if (op === "delete" && phase === "before" && failDeletes > 0) {
          failDeletes--;
          throw new ProviderUnavailableError();
        }
      },
    });
    const a = await newVault(provider);
    a.files.set("x.md", "1");
    await a.sync.sync();
    failDeletes = 1;
    a.files.set("x.md", "2");
    await a.sync.sync();
    expect(provider.objects.size).toBe(4); // the replaced blob is still there…
    expect(a.store.state?.pending).toHaveLength(1); // …and still recorded
    await a.sync.sync();
    expect(provider.objects.size).toBe(3);
    expect(a.store.state?.pending).toEqual([]);
  });

  it("a restart between the commit and the clean-up still deletes the replaced blob", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("x.md", "1");
    await a.sync.sync();
    a.files.set("x.md", "2");
    const setBase = a.store.setBase.bind(a.store);
    a.store.setBase = async () => {
      throw new Error("tab closed");
    };
    await expect(a.sync.sync()).rejects.toThrow("tab closed");
    a.store.setBase = setBase;
    expect(provider.objects.size).toBe(4); // committed, not yet cleaned
    const restarted = new E2eeSync({ provider, keys: a.keys, local: a.files, store: a.store });
    expect(await restarted.sync()).toMatchObject({ uploaded: 0 });
    expect(provider.objects.size).toBe(3);
    expect(a.store.state?.pending).toEqual([]);
  });
});

describe("e2ee sync: folders and files trading places", () => {
  it("a folder replaced by a file, and a file replaced by a folder, reach a real vault", async () => {
    const provider = memoryProvider();
    const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const vault = createMemoryBackend();
    await vault.write("a/b.md", "inside a");
    await vault.write("c", "c is a file");
    const v = new E2eeSync({ provider, keys, local: vaultLocalFiles(vault), store: memoryStateStore() });
    await v.markCreated(anchor);
    await v.sync();
    const m = device("M", provider, keys);
    await m.sync.sync();
    m.files.delete("a/b.md");
    m.files.set("a", "a is now a file");
    m.files.delete("c");
    m.files.set("c/d.md", "c is now a folder");
    await m.sync.sync();
    const r = await v.sync();
    expect(r.held).toEqual([]);
    expect(await vault.readText("a")).toBe("a is now a file");
    expect(await vault.readText("c/d.md")).toBe("c is now a folder");
    expect((await vault.stat("c"))?.kind).toBe("directory");
  });

  it("a deep folder replaced by a file clears the empty folders left behind", async () => {
    const provider = memoryProvider();
    const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const vault = createMemoryBackend();
    await vault.write("a/b/c.md", "deep");
    await vault.write("a/b/d/e.md", "deeper");
    const v = new E2eeSync({ provider, keys, local: vaultLocalFiles(vault), store: memoryStateStore() });
    await v.markCreated(anchor);
    await v.sync();
    const m = device("M", provider, keys);
    await m.sync.sync();
    m.files.delete("a/b/c.md");
    m.files.delete("a/b/d/e.md");
    m.files.set("a", "now a file");
    await m.sync.sync();
    expect((await v.sync()).held).toEqual([]);
    expect(await vault.readText("a")).toBe("now a file");
  });

  it("holds a file whose place is taken by a folder that still has notes, without stopping the round", async () => {
    const provider = memoryProvider();
    const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const vault = createMemoryBackend();
    const v = new E2eeSync({ provider, keys, local: vaultLocalFiles(vault), store: memoryStateStore() });
    await v.markCreated(anchor);
    const m = device("M", provider, keys);
    m.files.set("x", "x is a file there");
    m.files.set("y.md", "y");
    await m.sync.sync();
    await vault.write("x/kept.md", "x is a folder here"); // created locally before the first sync
    const r = await v.sync();
    // The folder's note is held too: the manifest never holds both `x` and `x/…`.
    expect(r.held.sort()).toEqual(["x", "x/kept.md"]);
    expect(await vault.readText("y.md")).toBe("y");
    expect(await vault.readText("x/kept.md")).toBe("x is a folder here");
    expect(Object.keys(await liveFiles(provider, keys)).sort()).toEqual(["x", "y.md"]);

    // Once the user moves the folder away, both sides settle.
    await vault.rename("x", "x-folder");
    const r2 = await v.sync();
    expect(r2.held).toEqual([]);
    expect(await vault.readText("x")).toBe("x is a file there");
    expect(Object.keys(await liveFiles(provider, keys)).sort()).toEqual(["x", "x-folder/kept.md", "y.md"]);
  });

  it("the reverse clash — a local file where the other side has a folder — is held the same way", async () => {
    const provider = memoryProvider();
    const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const vault = createMemoryBackend();
    const v = new E2eeSync({ provider, keys, local: vaultLocalFiles(vault), store: memoryStateStore() });
    await v.markCreated(anchor);
    const m = device("M", provider, keys);
    m.files.set("x/a.md", "a note in folder x");
    await m.sync.sync();
    await vault.write("x", "x is a file here");
    const r = await v.sync();
    expect(r.held.sort()).toEqual(["x", "x/a.md"]);
    expect(await vault.readText("x")).toBe("x is a file here");
    expect(Object.keys(await liveFiles(provider, keys))).toEqual(["x/a.md"]);
  });
});

/** The live (not deleted) paths of the manifest at `provider`. */
async function liveFiles(provider: ReturnType<typeof memoryProvider>, keys: Parameters<typeof manifestName>[0]) {
  const { manifest } = await openManifest(keys, provider.objects.get(await manifestName(keys))!.data);
  return Object.fromEntries(Object.entries(manifest.files).filter(([, e]) => !e.deleted));
}

describe("e2ee sync: paths the local vault cannot hold", () => {
  it("a name the platform refuses is held and reported; the rest of the round syncs", async () => {
    const provider = memoryProvider();
    const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const inner = createMemoryBackend();
    // Like the Windows desktop backend: `:` in a name is refused with EINVAL.
    const guard = (p: string) => {
      if (p.includes(":")) throw new VaultError("EINVAL", p);
    };
    const windows: VaultBackend = {
      ...inner,
      stat: async (p) => (guard(p), inner.stat(p)),
      read: async (p) => (guard(p), inner.read(p)),
      write: async (p, d) => (guard(p), inner.write(p, d)),
      remove: async (p) => (guard(p), inner.remove(p)),
    };
    const v = new E2eeSync({ provider, keys, local: vaultLocalFiles(windows), store: memoryStateStore() });
    await v.markCreated(anchor);
    const m = device("M", provider, keys);
    m.files.set("notes/12:30 meeting.md", "from a Mac");
    m.files.set("notes/ok.md", "fine everywhere");
    await m.sync.sync();
    for (let i = 0; i < 2; i++) {
      const r = await v.sync();
      expect(r.held).toEqual(["notes/12:30 meeting.md"]);
    }
    expect(await inner.readText("notes/ok.md")).toBe("fine everywhere");
    // Later changes keep flowing past the held path.
    m.files.set("notes/ok.md", "edited");
    await m.sync.sync();
    await v.sync();
    expect(await inner.readText("notes/ok.md")).toBe("edited");
    // Nothing was lost at the provider: the other device still has the note.
    expect(m.files.text("notes/12:30 meeting.md")).toBe("from a Mac");
    expect(Object.keys(await liveFiles(provider, keys)).sort()).toEqual(["notes/12:30 meeting.md", "notes/ok.md"]);
  });
});

describe("e2ee sync: a manifest write with a lost answer", () => {
  it("still deletes the blob it replaced, on the next round", async () => {
    let failNext = false;
    let manifest = "";
    const provider = memoryProvider({
      fault: (op, name, phase) => {
        if (failNext && op === "put" && name === manifest && phase === "after") {
          failNext = false;
          throw new ProviderUnavailableError();
        }
      },
    });
    const a = await newVault(provider);
    manifest = await manifestName(a.keys);
    a.files.set("x.md", "1");
    await a.sync.sync();
    expect(provider.objects.size).toBe(3);
    a.files.set("x.md", "2");
    failNext = true;
    await expect(a.sync.sync()).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(provider.objects.size).toBe(4);
    expect(await a.sync.sync()).toMatchObject({ uploaded: 0 });
    expect(provider.objects.size).toBe(3);
    expect(a.store.state?.pending).toEqual([]);
    expect(a.store.state?.committing).toEqual([]);
    const b = await joinVault("B", provider);
    await b.sync.sync();
    expect(b.files.text("x.md")).toBe("2");
  });

  it("keeps the old blob when the write did not land", async () => {
    let failNext = false;
    let manifest = "";
    const provider = memoryProvider({
      fault: (op, name, phase) => {
        if (failNext && op === "put" && name === manifest && phase === "before") {
          failNext = false;
          throw new ProviderUnavailableError();
        }
      },
    });
    const a = await newVault(provider);
    manifest = await manifestName(a.keys);
    a.files.set("x.md", "1");
    await a.sync.sync();
    a.files.set("x.md", "2");
    failNext = true;
    await expect(a.sync.sync()).rejects.toBeInstanceOf(ProviderUnavailableError);
    // Another device reads the old manifest meanwhile: its blob must still be there.
    const b = await joinVault("B", provider);
    a.files.set("x.md", "1"); // and A even goes back to the old text
    await a.sync.sync();
    await b.sync.sync();
    expect(b.files.text("x.md")).toBe("1");
  });
});

describe("e2ee sync: newer manifests must descend from the trusted one", () => {
  it("a newer counter from another branch is a fork, not an update", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    const name = await manifestName(a.keys);
    a.files.set("n.md", "base");
    await a.sync.sync();
    const b = await joinVault("B", provider);
    await b.sync.sync();
    await b.sync.pair(await a.sync.pairingCode());
    const fork = provider.objects.get(name)!; // counter 2, both devices anchored here

    a.files.set("n.md", "A's edit");
    await a.sync.sync(); // counter 3 on A's branch
    const aBranch = provider.objects.get(name)!;

    // The provider hides A's commit from B and lets B build its own branch past it.
    provider.objects.set(name, fork);
    b.files.set("n.md", "B's edit on a hidden branch");
    await b.sync.sync(); // 3'
    b.files.set("other.md", "more");
    await b.sync.sync(); // 4'
    expect((await openManifest(a.keys, provider.objects.get(name)!.data)).manifest.counter).toBe(4);

    // A, anchored at its own 3, refuses B's 4': its history lists another 3.
    await expect(a.sync.sync()).rejects.toMatchObject({ kind: "fork" });
    expect(a.files.text("n.md")).toBe("A's edit");
    // And B, anchored at 4', refuses A's branch as older.
    provider.objects.set(name, aBranch);
    await expect(b.sync.sync()).rejects.toMatchObject({ kind: "older" });
  });

  it("a device too far behind to prove ancestry drops to unverified instead of claiming it", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    await a.sync.sync();
    const c = await joinVault("C", provider);
    await c.sync.sync();
    await c.sync.pair(await a.sync.pairingCode());
    expect(await c.sync.freshness()).toMatchObject({ verified: true });
    for (let i = 0; i < HISTORY_LENGTH + 1; i++) {
      a.files.set("n.md", `v${i}`);
      await a.sync.sync();
    }
    await c.sync.sync();
    expect(c.files.text("n.md")).toBe(`v${HISTORY_LENGTH}`);
    expect(await c.sync.freshness()).toMatchObject({ source: "unverified", verified: false });
    // A device that keeps up stays verified.
    a.files.set("n.md", "again");
    await a.sync.sync();
    await c.sync.pair(await a.sync.pairingCode());
    a.files.set("n.md", "and again");
    await a.sync.sync();
    await c.sync.sync();
    expect(await c.sync.freshness()).toMatchObject({ source: "paired", verified: true });
  });

  it("refuses a manifest whose history is malformed", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    a.files.set("n.md", "x");
    await a.sync.sync();
    const name = await manifestName(a.keys);
    const { manifest } = await openManifest(a.keys, provider.objects.get(name)!.data);
    expect(manifest.history.map(([n]) => n)).toEqual([1]);
    for (const history of [[[5, "x"]], [[1, "a"], [1, "b"]], [["1", "a"]]] as unknown as Array<Array<[number, string]>>) {
      const bad = await sealManifest(a.keys, { ...manifest, history });
      await expect(openManifest(a.keys, bad.bytes)).rejects.toBeInstanceOf(DecryptError);
    }
  });
});
