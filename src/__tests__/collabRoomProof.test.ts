// Review 2 (12.11): the public collab server's token needs the room proof, and a proof of work for it.
import { describe, expect, it } from "vitest";
import { MAX_ROOM_POW_BITS, committedRoomName, proofVerifier, roomBaseName, roomProof, solveRoomPow } from "../collab/roomProof";
// @ts-expect-error -- plain ESM server module, no types
import * as server from "../../sync-server/collab/roomToken.mjs";


describe("room proof (review 2)", () => {
  it("is derived from the room password and the room, and the server checks it by its hash only", async () => {
    const a = await roomProof("correct horse", "room-1");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await roomProof("correct horse", "room-1")).toBe(a);
    expect(await roomProof("correct horse", "room-2")).not.toBe(a);
    expect(await roomProof("wrong horse", "room-1")).not.toBe(a);
    expect(server.proofVerifier(a)).toBe(await proofVerifier(a));
    expect(server.proofVerifier("short")).toBeNull();
    expect(server.proofVerifier(undefined)).toBeNull();
  });

  it("a token names the proof it was issued for; one issued without stays without", () => {
    const key = server.signingKey("k".repeat(40));
    const v = "a".repeat(64);
    const t = server.issueRoomToken(key, "room-1", { verifier: v }).token;
    expect(server.verifyRoomToken(key, t, "room-1")).toBeNull();
    expect(server.tokenVerifier(t)).toBe(v);
    expect(server.tokenVerifier(server.issueRoomToken(key, "room-1").token)).toBeNull();
  });

  it("the proof of work the app solves is the one the server checks, bound to the room and the proof", async () => {
    const v = await proofVerifier(await roomProof("pw", "room-1"));
    const nonce = await solveRoomPow("room-1", v, 10);
    expect(server.roomPowOk("room-1", v, nonce, 10)).toBe(true);
    expect(server.roomPowOk("room-2", v, nonce, 10) && server.roomPowOk("room-1", "b".repeat(64), nonce, 10)).toBe(false);
    expect(server.MAX_ROOM_POW_BITS).toBe(MAX_ROOM_POW_BITS);
    await expect(solveRoomPow("room-1", v, MAX_ROOM_POW_BITS + 1)).rejects.toThrow(/refused/);
  });
});

describe("room commitment (review 4, RR4-469-1)", () => {
  it("the app's server-side name commits to its proof, and the server checks it", async () => {
    const proof = await roomProof("pw", "team-notes");
    const name = await committedRoomName("team-notes", "pw");
    expect(name).toMatch(/^team-notes_k[0-9a-f]{32}$/);
    expect(roomBaseName(name)).toBe("team-notes");
    expect(roomBaseName("team-notes")).toBe("team-notes");
    expect(server.splitCommittedRoom(name)).toEqual({ base: "team-notes", commit: name.slice(-32) });
    expect(server.commitmentOk(name, server.proofVerifier(proof))).toBe(true);
    // A stranger's proof (another password) does not match the name.
    expect(server.commitmentOk(name, server.proofVerifier(await roomProof("guess", "team-notes")))).toBe(false);
    expect(server.commitmentOk("team-notes", server.proofVerifier(proof))).toBe(false);
    expect(await committedRoomName("team-notes", "other")).not.toBe(name);
  });

  it("names a room binds by: committed, the app's old random names, and open names that bind nothing", async () => {
    expect(server.roomKind(await committedRoomName("lumen-" + "a".repeat(32), "pw"))).toBe("committed");
    expect(server.roomKind("lumen-" + "0123456789abcdef".repeat(2))).toBe("app");
    expect(server.roomKind("team-notes")).toBe("open");
    expect(server.roomKind("lumen-calm-river-42")).toBe("open");
  });
});
