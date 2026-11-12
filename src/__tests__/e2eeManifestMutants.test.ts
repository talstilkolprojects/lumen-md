/**
 * Plan W4.17 — tests for the mutants that survived the sync suites in
 * src/sync/e2ee/manifest.ts: every field a manifest is checked for, the
 * shape of its history, the freshness rules (replay, fork, unproven) and
 * the canonical plaintext that makes the digest stable.
 */
import { describe, expect, it } from "vitest";
import { utf8 } from "../sync/e2ee/bytes";
import { PROTOCOL_VERSION } from "../sync/e2ee/header";
import { DecryptError, deriveVaultKeys, seal, type VaultKeys } from "../sync/e2ee/keys";
import { blobName, checkFreshness, emptyManifest, HISTORY_LENGTH, manifestName, openManifest, pathRecord, RollbackError, sealManifest, type Manifest } from "../sync/e2ee/manifest";

const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const keys = (): Promise<VaultKeys> => deriveVaultKeys(new Uint8Array(32).fill(7), VAULT);
const entry = { ver: 1, rev: "r1", hash: "h", size: 3, by: "dev" };
const good = (over: Record<string, unknown> = {}) => ({ protocol: PROTOCOL_VERSION, vaultId: VAULT, counter: 3, files: { "a.md": entry }, history: [[1, "d1"], [2, "d2"]], ...over });
async function sealRaw(k: VaultKeys, value: unknown): Promise<Uint8Array> {
  return seal(k.manifest, k.vaultId, "manifest", await manifestName(k), utf8(JSON.stringify(value)));
}
async function refused(k: VaultKeys, value: unknown): Promise<string> {
  try {
    await openManifest(k, await sealRaw(k, value));
  } catch (e) {
    expect(e).toBeInstanceOf(DecryptError);
    return (e as Error).message;
  }
  throw new Error(`accepted: ${JSON.stringify(value)}`);
}

describe("manifest, mutant-killing cases", () => {
  it("a path record has no prototype and copies own keys only", () => {
    const r = pathRecord({ a: 1, __proto__x: 2 } as Record<string, number>);
    expect(Object.getPrototypeOf(r)).toBe(null);
    expect(Object.keys(r)).toEqual(["a", "__proto__x"]);
    expect(Object.keys(pathRecord())).toEqual([]);
    expect(emptyManifest("v")).toEqual({ protocol: PROTOCOL_VERSION, vaultId: "v", counter: 0, files: pathRecord(), history: [] });
  });

  it("opens a well-formed manifest and returns the digest of its plaintext", async () => {
    const k = await keys();
    const m: Manifest = { ...emptyManifest(VAULT), counter: 3, files: pathRecord({ "a.md": entry, "b.md": { ver: 2, rev: "", hash: "", size: 0, by: "d", deleted: true } }), history: [[1, "d1"], [2, "d2"]] };
    const sealed = await sealManifest(k, m);
    const opened = await openManifest(k, sealed.bytes);
    expect(opened.digest).toBe(sealed.digest);
    expect(opened.manifest).toEqual(m);
    // The name can be passed or found.
    expect((await openManifest(k, sealed.bytes, await manifestName(k))).digest).toBe(sealed.digest);
  });

  it("seals the same plaintext whatever the order of its paths", async () => {
    const k = await keys();
    const a = await sealManifest(k, { ...emptyManifest(VAULT), counter: 1, files: pathRecord({ "a.md": entry, "b.md": entry }) });
    const b = await sealManifest(k, { ...emptyManifest(VAULT), counter: 1, files: pathRecord({ "b.md": entry, "a.md": entry }) });
    expect(a.digest).toBe(b.digest);
    const c = await sealManifest(k, { ...emptyManifest(VAULT), counter: 2, files: pathRecord({ "a.md": entry, "b.md": entry }) });
    expect(c.digest).not.toBe(a.digest);
  });

  it("refuses the wrong protocol, vault, counter or files", async () => {
    const k = await keys();
    expect(await refused(k, good({ protocol: PROTOCOL_VERSION + 1 }))).toMatch(/protocol/);
    expect(await refused(k, good({ vaultId: "BBBBBBBBBBBBBBBBBBBBBB" }))).toMatch(/another vault/);
    for (const counter of [0, -1, 1.5, "3", null]) expect(await refused(k, good({ counter, history: [] }))).toMatch(/counter/);
    for (const files of [null, "x", 5]) expect(await refused(k, good({ files }))).toMatch(/files/);
    // Counter 1 is the first valid one.
    expect((await openManifest(k, await sealRaw(k, good({ counter: 1, history: [] })))).manifest.counter).toBe(1);
  });

  it("refuses an entry field by field, and a path that is not synced", async () => {
    const k = await keys();
    const bad = [{ ...entry, ver: 0 }, { ...entry, ver: 1.5 }, { ...entry, ver: "1" }, { ...entry, rev: 1 }, { ...entry, hash: null }, { ...entry, size: 1.2 }, { ...entry, size: "3" }, { ...entry, by: 9 }, { ...entry, deleted: false }, null, "x"];
    for (const e of bad) expect(await refused(k, good({ files: { "a.md": e } }))).toMatch(/entry/);
    for (const p of ["../escape.md", "a//b.md", "./a.md"]) expect(await refused(k, good({ files: { [p]: entry } }))).toMatch(/entry/);
    // deleted: true and ver ≥ 1 are fine.
    expect(Object.keys((await openManifest(k, await sealRaw(k, good({ files: { "a.md": { ...entry, ver: 9, deleted: true } } })))).manifest.files)).toEqual(["a.md"]);
  });

  it("refuses a history that is not ascending predecessors, too long, or malformed", async () => {
    const k = await keys();
    const histories: unknown[] = [
      "x",
      null,
      [[1, "d"], [1, "e"]],
      [[2, "d"], [1, "e"]],
      [[3, "d"]],
      [[4, "d"]],
      [[1, "d", "x"]],
      [[1]],
      [["1", "d"]],
      [[1.5, "d"]],
      [[1, 2]],
      ["1,d"],
      Array.from({ length: HISTORY_LENGTH + 1 }, (_, i) => [i + 1, "d"]),
    ];
    for (const history of histories) expect(await refused(k, good({ counter: history && Array.isArray(history) && history.length > 50 ? HISTORY_LENGTH + 5 : 3, history }))).toMatch(/history/);
    const full = Array.from({ length: HISTORY_LENGTH }, (_, i) => [i + 1, `d${i}`]);
    expect((await openManifest(k, await sealRaw(k, good({ counter: HISTORY_LENGTH + 1, history: full })))).manifest.history).toHaveLength(HISTORY_LENGTH);
    expect((await openManifest(k, await sealRaw(k, good({ history: [] })))).manifest.history).toEqual([]);
  });

  it("names blobs by path and revision, never by the path itself", async () => {
    const k = await keys();
    const a = await blobName(k, "a.md", "r1");
    expect(a).not.toContain("a.md");
    expect(await blobName(k, "a.md", "r1")).toBe(a);
    expect(await blobName(k, "a.md", "r2")).not.toBe(a);
    expect(await blobName(k, "b.md", "r1")).not.toBe(a);
    expect(await manifestName(k)).not.toBe(a);
  });
});

describe("checkFreshness", () => {
  const A = { counter: 5, digest: "d5" };
  it("accepts anything without an anchor, and the anchored manifest itself", () => {
    expect(checkFreshness(null, { counter: 1, digest: "x" })).toBe("ok");
    expect(checkFreshness(A, { counter: 5, digest: "d5" })).toBe("ok");
  });

  it("refuses an older manifest (replay) and a different one with the same counter (fork)", () => {
    const older = (() => {
      try {
        checkFreshness(A, { counter: 4, digest: "d4" });
      } catch (e) {
        return e as RollbackError;
      }
      return null;
    })();
    expect(older).toBeInstanceOf(RollbackError);
    expect(older).toMatchObject({ name: "RollbackError", seen: 5, got: 4, kind: "older" });
    expect(older!.message).toMatch(/older than 5/);
    expect(() => checkFreshness(A, { counter: 5, digest: "other" })).toThrow(/same counter 5/);
  });

  it("a newer manifest must list the anchor with its digest among its predecessors", () => {
    expect(checkFreshness(A, { counter: 7, digest: "d7" }, [[4, "d4"], [5, "d5"], [6, "d6"]])).toBe("ok");
    expect(() => checkFreshness(A, { counter: 7, digest: "d7" }, [[5, "forked"], [6, "d6"]])).toThrow(RollbackError);
    expect(checkFreshness(A, { counter: 7, digest: "d7" }, [[6, "d6"]])).toBe("unproven");
    expect(checkFreshness(A, { counter: 7, digest: "d7" })).toBe("unproven");
    expect(checkFreshness(A, { counter: 6, digest: "d6" }, [])).toBe("unproven");
  });
});
