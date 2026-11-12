// Review 2 (12.11): the public collab server's token needs the room proof, and a proof of work for it.
import { describe, expect, it } from "vitest";
import { MAX_ROOM_POW_BITS, proofVerifier, roomProof, solveRoomPow } from "../collab/roomProof";
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
