/**
 * Plan W5.11, part 3: a note locked with its own password inside an ordinary
 * vault. Cheap PBKDF2 here (production: 600,000 iterations, kdf.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetLockedNotes,
  allowEnvelopeWrite,
  allowPlainWrite,
  forgetOpen,
  isEnvelopeText,
  isSealedNote,
  LOCKED_NOTE_MAGIC,
  lockNote,
  LockedNoteOverwriteError,
  makeSealer,
  openSealed,
  rememberOpen,
  unlockNote,
  WrongNotePasswordError,
} from "../storage/lockedNote";
import { lockedNotes, noteSealer } from "../storage/lockedNotesRegistry";

const FAST = { pbkdf2Iterations: 1000 };
const POLICY = { minPbkdf2Iterations: 1000 };
const SECRET = "המקור: דנה לוי, 054-1234567. Meet at Herzl 12.";

afterEach(() => __resetLockedNotes());

describe("lockNote / unlockNote", () => {
  it("round-trips Hebrew and English; the file holds none of the text", async () => {
    const { sealed } = await lockNote(SECRET, "correct horse", FAST);
    expect(isSealedNote(sealed)).toBe(true);
    for (const word of ["דנה", "054", "Herzl", "1234567"]) expect(sealed).not.toContain(word);
    const { plain } = await unlockNote(sealed, "correct horse", POLICY);
    expect(plain).toBe(SECRET);
  });

  it("a wrong password, a changed byte or changed KDF parameters fail", async () => {
    const { sealed } = await lockNote(SECRET, "correct horse", FAST);
    await expect(unlockNote(sealed, "wrong horse!", POLICY)).rejects.toBeInstanceOf(WrongNotePasswordError);
    const m = /lumen-locked:([A-Za-z0-9_-]+)/.exec(sealed) as RegExpExecArray;
    const env = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    const reencode = (o: unknown) => sealed.replace(m[1], btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    const ct = env.ct as string;
    const flipped = { ...env, ct: ct.slice(0, 5) + (ct[5] === "A" ? "B" : "A") + ct.slice(6) };
    await expect(unlockNote(reencode(flipped), "correct horse", POLICY)).rejects.toBeInstanceOf(WrongNotePasswordError);
    const moreIter = { ...env, kdf: { ...env.kdf, iterations: env.kdf.iterations + 1 } };
    await expect(unlockNote(reencode(moreIter), "correct horse", POLICY)).rejects.toBeInstanceOf(WrongNotePasswordError);
  });

  it("refuses short passwords and too-weak KDF parameters", async () => {
    await expect(lockNote(SECRET, "short", FAST)).rejects.toBeInstanceOf(RangeError);
    const { sealed } = await lockNote(SECRET, "correct horse", FAST);
    // Without the test policy, 1,000 PBKDF2 iterations are below the 600,000 floor.
    await expect(unlockNote(sealed, "correct horse")).rejects.toThrow(/iterations/);
  });
});

describe("the write hook", () => {
  it("seals every save with a fresh nonce; the registry keeps only sealed text", async () => {
    const { sealed, key } = await lockNote(SECRET, "correct horse", FAST);
    const disk = new Map<string, string>([["notes/source.md", sealed]]);
    rememberOpen("notes/source.md", key, sealed, async (p) => disk.get(p) ?? null);
    const seal = noteSealer();
    expect(seal).not.toBeNull();
    const a = await seal!("notes/source.md", SECRET + " v2");
    const b = await seal!("notes/source.md", SECRET + " v2");
    expect(a).not.toBe(b);
    expect(a).not.toContain("Herzl");
    expect(await openSealed(b, key, POLICY)).toBe(SECRET + " v2");
    expect(lockedNotes.atRest("notes/source.md", SECRET)).toBe(b);
    expect(lockedNotes.atRest("notes/other.md", "plain")).toBe("plain");
  });

  it("follows a rename", async () => {
    const { sealed, key } = await lockNote(SECRET, "correct horse", FAST);
    rememberOpen("a.md", key, sealed, async () => null);
    lockedNotes.rename("a.md", "b.md");
    const out = await noteSealer()!("b.md", SECRET);
    expect(isSealedNote(out)).toBe(true);
    expect(await noteSealer()!("a.md", "new plain note")).toBe("new plain note");
  });

  it("never writes plain text over a locked note that is not open", async () => {
    const { sealed, key } = await lockNote(SECRET, "correct horse", FAST);
    const disk = new Map<string, string>([["s.md", sealed]]);
    const seal = makeSealer(async (p) => disk.get(p) ?? null);
    rememberOpen("s.md", key, sealed, async (p) => disk.get(p) ?? null);
    forgetOpen("s.md");
    await expect(seal("s.md", "edited plain")).rejects.toBeInstanceOf(LockedNoteOverwriteError);
    // Sealed text (the editor showing the locked file) passes as it is.
    expect(await seal("s.md", sealed)).toBe(sealed);
    // Removing the password allows exactly one plain write.
    allowPlainWrite("s.md");
    expect(await seal("s.md", "plain again")).toBe("plain again");
    await expect(seal("s.md", "and again")).rejects.toBeInstanceOf(LockedNoteOverwriteError);
  });

  it("seals an open note's text even when it starts with the magic line; only its own envelope passes (review 12.11)", async () => {
    const { sealed, key } = await lockNote(SECRET, "correct horse", FAST);
    const disk = new Map<string, string>([["s.md", sealed]]);
    const seal = makeSealer(async (p) => disk.get(p) ?? null);
    rememberOpen("s.md", key, sealed, async (p) => disk.get(p) ?? null);
    // Plain text that begins with the magic line (a pasted sealed note, typed under).
    const lookalike = `${LOCKED_NOTE_MAGIC}\nSource: ${SECRET}\n`;
    expect(isSealedNote(lookalike)).toBe(true);
    expect(isEnvelopeText(lookalike)).toBe(false);
    const out = await seal("s.md", lookalike);
    expect(out).not.toContain("054-1234567");
    expect(await openSealed(out, key, POLICY)).toBe(lookalike);
    // The note's own envelope passes as it is (no double sealing) …
    expect(await seal("s.md", sealed)).toBe(sealed);
    // … an envelope under another password is sealed again, not written as it is.
    const other = (await lockNote("other text", "another password", FAST)).sealed;
    const resealed = await seal("s.md", other);
    expect(resealed).not.toBe(other);
    expect(await openSealed(resealed, key, POLICY)).toBe(other);
    // Closed again: a lookalike over the locked file is refused like any plain text.
    forgetOpen("s.md");
    await expect(seal("s.md", lookalike)).rejects.toBeInstanceOf(LockedNoteOverwriteError);
  });

  it("review 2: a closed locked note is not replaced by an envelope under another password; one with its own key passes", async () => {
    const { sealed, key } = await lockNote(SECRET, "correct horse", FAST);
    const disk = new Map<string, string>([["s.md", sealed]]);
    const seal = makeSealer(async (p) => disk.get(p) ?? null);
    const foreign = (await lockNote("nothing here", "attacker pass", FAST)).sealed;
    await expect(seal("s.md", foreign)).rejects.toBeInstanceOf(LockedNoteOverwriteError);
    // The same envelope passes. A newer one sealed with the note's own key (a synced device) passes only
    // when the caller vouches for it: its salt is in the file, so anyone could copy it (review 4).
    expect(await seal("s.md", sealed)).toBe(sealed);
    rememberOpen("s.md", key, sealed, async (p) => disk.get(p) ?? null);
    const newer = await seal("s.md", "an edit");
    forgetOpen("s.md");
    await expect(seal("s.md", newer)).rejects.toBeInstanceOf(LockedNoteOverwriteError);
    allowEnvelopeWrite("s.md");
    expect(await seal("s.md", newer)).toBe(newer);
    await expect(seal("s.md", newer)).rejects.toBeInstanceOf(LockedNoteOverwriteError); // one write only
    // Removing the password is the explicit way to write something else.
    allowPlainWrite("s.md");
    expect(await seal("s.md", foreign)).toBe(foreign);
  });
});

