/**
 * A note locked with its own password, inside an ordinary vault (plan W5.11,
 * journalist mode, part 3).
 *
 * On disk the note is a text file anyone can see is locked, and nobody can
 * read without the password:
 *
 *     <!-- lumen-locked-note v1 -->
 *     🔒 … (one line, English and Hebrew, saying how to open it)
 *
 *     lumen-locked:<base64url of {"v":1,"kdf":{…},"iv":"…","ct":"…"}>
 *
 * The key is derived from the password with the vault KDF (src/sync/e2ee/kdf.ts:
 * PBKDF2-SHA256 with 600,000 iterations today; the parameters travel with the
 * note, so a note made after Argon2id lands in kdf.ts (#399 / #472) uses it,
 * and older notes still open). The text is sealed with AES-256-GCM under a
 * fresh 96-bit nonce on every save; the version and the KDF parameters are
 * the additional data, so changing them breaks the seal.
 *
 * While the note is open, its key stays in memory only (lockedNotesRegistry
 * holds the sealed text, for what the app keeps at rest). "Lock now", a
 * reload, or closing the app forgets it.
 */

import { bs, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "../sync/e2ee/bytes";
import { deriveMasterKey, newKdfParams, validateKdfParams, type KdfParams, type KdfPolicy } from "../sync/e2ee/kdf";
import { isSealedNote, LOCKED_NOTE_MAGIC, lockedNotes, setNoteSealer } from "./lockedNotesRegistry";

export { isSealedNote, LOCKED_NOTE_MAGIC };

/** A note password is short-lived memory, not a vault passphrase; still, 8 characters at least. */
export const MIN_NOTE_PASSWORD = 8;

const PAYLOAD = /^lumen-locked:([A-Za-z0-9_-]+)$/m;
const NOTICE =
  "🔒 This note is locked with its own password. Open it in Lumen: Command palette → “Note password”. · הפתק הזה נעול בסיסמה משלו. פותחים אותו ב-Lumen: לוח הפקודות ← ״סיסמת פתק״.";

export class WrongNotePasswordError extends Error {
  constructor() {
    super("Wrong password for this note (or the note was changed)");
    this.name = "WrongNotePasswordError";
  }
}

export class NotALockedNoteError extends Error {
  constructor() {
    super("This note is not locked with a password");
    this.name = "NotALockedNoteError";
  }
}

/** The open note's key; kept in memory only. */
export interface NoteKey {
  key: CryptoKey;
  kdf: KdfParams;
}

interface Envelope {
  v: 1;
  kdf: KdfParams;
  iv: string;
  ct: string;
}

const aad = (kdf: KdfParams) => utf8(`lumen-locked-note v1|${JSON.stringify(kdf)}`);

async function keyFrom(password: string, kdf: KdfParams): Promise<NoteKey> {
  const raw = await deriveMasterKey(password, kdf);
  const key = await crypto.subtle.importKey("raw", bs(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return { key, kdf };
}

/** Seal `plain` under an existing key (each save: a new nonce). */
export async function sealNote(plain: string, k: NoteKey): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad(k.kdf)) }, k.key, bs(utf8(plain))));
  const env: Envelope = { v: 1, kdf: k.kdf, iv: toB64u(iv), ct: toB64u(ct) };
  return `${LOCKED_NOTE_MAGIC}\n${NOTICE}\n\nlumen-locked:${toB64u(utf8(JSON.stringify(env)))}\n`;
}

export interface LockOptions {
  /** Tests only: cheaper PBKDF2. */
  pbkdf2Iterations?: number;
}

/** Lock `plain` with a new password: the sealed file text and the key to keep while it is open. */
export async function lockNote(plain: string, password: string, opts: LockOptions = {}): Promise<{ sealed: string; key: NoteKey }> {
  if (password.length < MIN_NOTE_PASSWORD) throw new RangeError(`A note password needs at least ${MIN_NOTE_PASSWORD} characters`);
  const key = await keyFrom(password, newKdfParams(opts.pbkdf2Iterations));
  return { sealed: await sealNote(plain, key), key };
}

function parse(sealed: string, policy: KdfPolicy): Envelope {
  if (!isSealedNote(sealed)) throw new NotALockedNoteError();
  const m = PAYLOAD.exec(sealed);
  if (!m) throw new WrongNotePasswordError();
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(fromUtf8(fromB64u(m[1]))) as Record<string, unknown>;
  } catch {
    throw new WrongNotePasswordError();
  }
  if (o.v !== 1 || typeof o.iv !== "string" || typeof o.ct !== "string") throw new WrongNotePasswordError();
  return { v: 1, kdf: validateKdfParams(o.kdf, policy), iv: o.iv, ct: o.ct };
}

/** Open a sealed note with its password: the text, and the key to seal its next saves. */
export async function unlockNote(sealed: string, password: string, policy: KdfPolicy = {}): Promise<{ plain: string; key: NoteKey }> {
  const env = parse(sealed, policy);
  const key = await keyFrom(password, env.kdf);
  return { plain: await openWith(env, key), key };
}

/** Open a sealed note with a key already derived (the note is open). */
export async function openSealed(sealed: string, key: NoteKey, policy: KdfPolicy = {}): Promise<string> {
  return openWith(parse(sealed, policy), key);
}

async function openWith(env: Envelope, k: NoteKey): Promise<string> {
  if (JSON.stringify(env.kdf) !== JSON.stringify(k.kdf)) throw new WrongNotePasswordError();
  try {
    const iv = fromB64u(env.iv);
    if (iv.length !== 12) throw new WrongNotePasswordError();
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad(env.kdf)) }, k.key, bs(fromB64u(env.ct)));
    return fromUtf8(new Uint8Array(pt));
  } catch {
    throw new WrongNotePasswordError();
  }
}

// ── The session: which open notes are locked, and their keys ──────────────

/** Paths whose next plain write is wanted (the password was just removed). */
const allowPlain = new Set<string>();

const keyOf = (path: string) => lockedNotes.key(path) as NoteKey | undefined;

export class LockedNoteOverwriteError extends Error {
  constructor(public readonly path: string) {
    super(`"${path}" is locked with its own password; unlock it before saving`);
    this.name = "LockedNoteOverwriteError";
  }
}

/** Only the envelope's shape is checked here; opening it checks the KDF against the key's own. */
const STRUCTURE_ONLY: KdfPolicy = { minPbkdf2Iterations: 1 };

/**
 * Is `text` exactly a sealed note as sealNote writes it (the magic line, the
 * notice, the payload, nothing else)? Starting with the magic line is not
 * enough: a plain note can start with it too (review 12.11).
 */
export function isEnvelopeText(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length !== 4 || lines[0] !== LOCKED_NOTE_MAGIC || lines[1] !== NOTICE || lines[2] !== "") return false;
  if (!/^lumen-locked:[A-Za-z0-9_-]+$/.test(lines[3])) return false;
  try {
    parse(text, STRUCTURE_ONLY);
    return true;
  } catch {
    return false;
  }
}

/** Do two envelopes carry the same KDF parameters (the same salt: sealed with the same key)? */
function sameKdf(a: string, b: string): boolean {
  try {
    return JSON.stringify(parse(a, STRUCTURE_ONLY).kdf) === JSON.stringify(parse(b, STRUCTURE_ONLY).kdf);
  } catch {
    return false;
  }
}

/**
 * The workspace write hook. An unlocked locked note is always sealed, unless
 * the text is already an envelope that opens with this note's key (which
 * nobody without the key can forge). Nothing is written over a locked note
 * that is not open (the editor showing the sealed text, a tool, an old tab)
 * but an envelope with the note's own KDF parameters (review 2): plain text
 * and an envelope under another password are refused alike.
 */
export function makeSealer(readCurrent: (path: string) => Promise<string | null>) {
  return async (path: string, content: string): Promise<string> => {
    const k = keyOf(path);
    if (k) {
      if (isEnvelopeText(content)) {
        try {
          // The envelope's KDF must equal this key's (openWith), so the shape-only policy loosens nothing.
          await openWith(parse(content, STRUCTURE_ONLY), k);
          lockedNotes.set(path, content, k);
          return content;
        } catch {
          /* why: an envelope under another key: sealed again below, never written as it is */
        }
      }
      const sealed = await sealNote(content, k);
      lockedNotes.set(path, sealed, k);
      return sealed;
    }
    if (allowPlain.delete(path)) return content;
    const current = await readCurrent(path);
    if (current === null || !isSealedNote(current)) return content;
    // A closed locked note (review 2): not even a well-formed envelope replaces it, unless it is the
    // same envelope or one sealed under the same password and salt (another tab or device that holds
    // the key: its KDF parameters, salt included, are the note's own). Anything else is refused.
    if (isEnvelopeText(content) && (content === current || sameKdf(content, current))) return content;
    throw new LockedNoteOverwriteError(path);
  };
}

/** Start sealing `path` with `key` (after lock or unlock); installs the write hook. */
export function rememberOpen(path: string, key: NoteKey, sealed: string, readCurrent: (path: string) => Promise<string | null>): void {
  allowPlain.delete(path);
  lockedNotes.set(path, sealed, key);
  setNoteSealer(makeSealer(readCurrent));
}

/** Forget the key of `path` ("Lock now"): its next read shows the sealed text. */
export function forgetOpen(path: string): void {
  lockedNotes.delete(path);
}

/** The password was removed: the next write of `path` may be plain. */
export function allowPlainWrite(path: string): void {
  lockedNotes.delete(path);
  allowPlain.add(path);
}

export function isOpenLocked(path: string): boolean {
  return lockedNotes.has(path);
}

/** Tests: forget every key. */
export function __resetLockedNotes(): void {
  for (const p of lockedNotes.paths()) lockedNotes.delete(p);
  allowPlain.clear();
  setNoteSealer(null);
}
