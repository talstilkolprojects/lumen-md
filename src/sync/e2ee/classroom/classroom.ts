/**
 * The private classroom (plan W5.21): a teacher shares a template, each
 * student works on their own copy, hands it in to the teacher only, and gets
 * the teacher's comments back — through a relay that sees only sealed boxes.
 *
 *   Teacher                         relay drop box d                  Student
 *   ───────                         ────────────────                  ───────
 *   assignment key pair (T)
 *   owner token o, d = HMAC(o)
 *   link #class= {template, T.pub, relay, d}  ───────────────────────▶ (any channel)
 *                                                          own key pair (S), per assignment
 *                                                          drafts stay on the device
 *                                   s-<random> ◀── PUT a.<d> seal(T.pub, {S.pub, name, work})
 *   o.<o> list + GET s-* ──▶ open with T
 *   seal(S.pub, from T, comment) ──▶ c-<slot(S.pub)>-<random>
 *                                          a.<d> list + GET c-<slot>-* ──▶ open with S, check T
 *
 * - A submission opens only with the assignment's private key, which never
 *   leaves the teacher's device. Another student — or the relay — holds the
 *   same ciphertext and cannot read it.
 * - The student's public key travels inside the sealed submission, so only
 *   the teacher learns it. Comments are sealed to it in mode 1 (from T):
 *   a student can check that a comment is the teacher's, and nobody but the
 *   teacher knows which slot holds which student's comments.
 * - The drop box is append-only for link holders (sync-server/vault-relay.js):
 *   nobody can replace or delete another student's submission.
 * - Every box is padded to a size bucket.
 *
 * The full threat model: docs/src/content/docs/sync/classroom.md.
 */

import { relayProvider } from "../providers/relay";
import type { FetchLike } from "../providers/http";
import type { SyncProvider } from "../provider";
import { fromBase64Url, toBase64Url, type ClassLink } from "./link";
import { newKeyPair, open, pad, rawPublic, seal, SealError, unpad } from "./seal";

/** The largest piece of work (Markdown characters) a submission carries. */
export const MAX_SUBMISSION_CHARS = 512 * 1024;
/** The largest comment. */
export const MAX_COMMENT_CHARS = 32 * 1024;
const DROP_LABEL = "lumen-vault-relay v1|drop";

export interface TeacherAssignment {
  role: "teacher";
  /** The drop box id (also the assignment's id). */
  id: string;
  title: string;
  template: string;
  relay: string;
  /** The owner token: full rights on the drop box. Never in the link. */
  owner: string;
  /** The assignment's private key (non-extractable). */
  key: CryptoKey;
  /** Its public key, base64url. */
  pub: string;
  created: number;
}

export interface SentSubmission {
  object: string;
  at: number;
  version: number;
}

export interface StudentAssignment {
  role: "student";
  id: string;
  title: string;
  relay: string;
  /** The teacher's assignment key, base64url (from the link). */
  teacherKey: string;
  /** The name the student signs with (inside the sealed box only). */
  name: string;
  /** This student's private key for this assignment (non-extractable). */
  key: CryptoKey;
  pub: string;
  joined: number;
  sent: SentSubmission[];
}

export type Assignment = TeacherAssignment | StudentAssignment;

export interface Submission {
  object: string;
  /** The student's public key for this assignment: who handed it in. */
  student: string;
  name: string;
  title: string;
  markdown: string;
  at: number;
  version: number;
}

export interface ClassComment {
  id: string;
  object: string;
  /** The submission it answers. */
  re: string;
  text: string;
  at: number;
}

export interface ClassDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** The transport (default: the relay's blob API). */
  provider?: (relay: string, token: string) => SyncProvider;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const nowOf = (deps: ClassDeps) => (deps.now ?? Date.now)();
/** The build's relay invite (review 12.11): a relay that asks for one won't open a drop box without it. */
const relayInvite = () => (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SYNC_RELAY_INVITE || undefined;
const providerOf = (deps: ClassDeps, relay: string, token: string) =>
  (deps.provider ?? ((url, t) => relayProvider({ url, token: t, invite: relayInvite() }, { fetch: deps.fetch })))(relay, token);
const random = (n: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));

/** The drop box id an owner token opens: the relay derives the same (vault-relay.js `dropIdOf`). */
export async function dropIdOf(owner: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(owner), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(DROP_LABEL))));
}

/** The object-name prefix of one student's comments: only who knows the student's key can tell it. */
export async function commentSlot(assignment: string, studentPub: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`lumen-class v1|slot|${assignment}|${studentPub}`)));
  return `c-${toBase64Url(digest).slice(0, 22)}-`;
}

/* ─── teacher ─── */

/** A new assignment from a template: the key pair and owner token stay here; the link goes to the class. */
export async function createAssignment(input: { title: string; template: string; relay: string }, deps: ClassDeps = {}): Promise<{ assignment: TeacherAssignment; link: ClassLink }> {
  const pair = await newKeyPair(false);
  const pub = toBase64Url(await rawPublic(pair.publicKey));
  const owner = random(32);
  const id = await dropIdOf(owner);
  const assignment: TeacherAssignment = { role: "teacher", id, title: input.title, template: input.template, relay: input.relay, owner, key: pair.privateKey, pub, created: nowOf(deps) };
  return { assignment, link: { title: input.title, template: input.template, teacherKey: pub, relay: input.relay, drop: id } };
}

/** The link's content for an assignment already made (to show it again). */
export function linkOf(a: TeacherAssignment): ClassLink {
  return { title: a.title, template: a.template, teacherKey: a.pub, relay: a.relay, drop: a.id };
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const o = JSON.parse(dec.decode(unpad(bytes))) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface SubmissionList {
  /** Every submission that opened, newest version per student first. */
  submissions: Submission[];
  /** Objects in the drop box that are not a submission to this assignment (noise, or someone's mistake). */
  unreadable: number;
}

/** Fetch and open everything handed in. */
export async function fetchSubmissions(a: TeacherAssignment, deps: ClassDeps = {}): Promise<SubmissionList> {
  const box = providerOf(deps, a.relay, `o.${a.owner}`);
  const me = { privateKey: a.key, publicRaw: fromBase64Url(a.pub) };
  const out: Submission[] = [];
  let unreadable = 0;
  for (const object of (await box.list()).filter((n) => n.startsWith("s-")).sort()) {
    const got = await box.get(object);
    if (!got) continue;
    const o = await open(got.data, me, { context: `sub|${a.id}` }).then(parseJson, () => null);
    if (
      !o ||
      o.v !== 1 ||
      o.kind !== "sub" ||
      o.a !== a.id ||
      typeof o.k !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/.test(o.k) ||
      typeof o.n !== "string" ||
      typeof o.t !== "string" ||
      typeof o.m !== "string" ||
      typeof o.at !== "number" ||
      typeof o.ver !== "number"
    ) {
      unreadable++;
      continue;
    }
    out.push({ object, student: o.k, name: o.n, title: o.t, markdown: o.m, at: o.at, version: o.ver });
  }
  out.sort((x, y) => (x.student === y.student ? y.version - x.version || y.at - x.at : x.name.localeCompare(y.name) || x.student.localeCompare(y.student)));
  return { submissions: out, unreadable };
}

/** Seal a comment to the student who handed in `to`; only that student can open it, and can tell it is the teacher's. */
export async function sendComment(a: TeacherAssignment, to: Submission, text: string, deps: ClassDeps = {}): Promise<ClassComment> {
  if (text.length > MAX_COMMENT_CHARS) throw new RangeError("comment too long");
  const comment = { id: random(12), re: to.object, text, at: nowOf(deps) };
  const body = enc.encode(JSON.stringify({ v: 1, kind: "cmt", a: a.id, to: to.student, id: comment.id, re: comment.re, m: text, at: comment.at }));
  const sealed = await seal(pad(body), fromBase64Url(to.student), { context: `cmt|${a.id}`, sender: a.key });
  const object = `${await commentSlot(a.id, to.student)}${random(12)}`;
  await providerOf(deps, a.relay, `o.${a.owner}`).put(object, sealed, { ifNoneMatch: "*" });
  return { ...comment, object };
}

/** End of the assignment: delete everything in its drop box (owner only). */
export async function closeAssignment(a: TeacherAssignment, deps: ClassDeps = {}): Promise<number> {
  const box = providerOf(deps, a.relay, `o.${a.owner}`);
  const names = await box.list();
  for (const n of names) await box.delete(n);
  return names.length;
}

/* ─── student ─── */

/** Join from a link: a key pair of this student's own, for this assignment only. */
export async function joinAssignment(link: ClassLink, name: string, deps: ClassDeps = {}): Promise<StudentAssignment> {
  const pair = await newKeyPair(false);
  return {
    role: "student",
    id: link.drop,
    title: link.title,
    relay: link.relay,
    teacherKey: link.teacherKey,
    name: name.trim().slice(0, 120),
    key: pair.privateKey,
    pub: toBase64Url(await rawPublic(pair.publicKey)),
    joined: nowOf(deps),
    sent: [],
  };
}

/**
 * Hand in `markdown` (the student's copy, as it is now). Only this sealed
 * box leaves the device; a draft never does. Resolves with the updated
 * assignment once the relay holds the box, read back byte for byte.
 */
export async function submit(s: StudentAssignment, markdown: string, deps: ClassDeps = {}): Promise<StudentAssignment> {
  if (markdown.length > MAX_SUBMISSION_CHARS) throw new RangeError("submission too long");
  const version = (s.sent.at(-1)?.version ?? 0) + 1;
  const at = nowOf(deps);
  const body = enc.encode(JSON.stringify({ v: 1, kind: "sub", a: s.id, k: s.pub, n: s.name, t: s.title, m: markdown, at, ver: version }));
  const sealed = await seal(pad(body), fromBase64Url(s.teacherKey), { context: `sub|${s.id}` });
  const box = providerOf(deps, s.relay, `a.${s.id}`);
  const object = `s-${random(18)}`;
  await box.put(object, sealed, { ifNoneMatch: "*" });
  const back = await box.get(object);
  if (!back || back.data.length !== sealed.length || back.data.some((b, i) => b !== sealed[i])) throw new Error("classroom: the relay did not keep the submission");
  return { ...s, sent: [...s.sent, { object, at, version }] };
}

/** The teacher's comments to this student, checked to come from the teacher's key; newest last. */
export async function fetchComments(s: StudentAssignment, deps: ClassDeps = {}): Promise<ClassComment[]> {
  const box = providerOf(deps, s.relay, `a.${s.id}`);
  const slot = await commentSlot(s.id, s.pub);
  const me = { privateKey: s.key, publicRaw: fromBase64Url(s.pub) };
  const teacher = fromBase64Url(s.teacherKey);
  const out: ClassComment[] = [];
  const seen = new Set<string>();
  for (const object of (await box.list()).filter((n) => n.startsWith(slot))) {
    const got = await box.get(object);
    if (!got) continue;
    const o = await open(got.data, me, { context: `cmt|${s.id}`, sender: teacher }).then(parseJson, (e: unknown) => {
      if (e instanceof SealError) return null;
      throw e;
    });
    if (!o || o.v !== 1 || o.kind !== "cmt" || o.a !== s.id || o.to !== s.pub || typeof o.id !== "string" || typeof o.re !== "string" || typeof o.m !== "string" || typeof o.at !== "number") continue;
    // A copy of the same sealed comment under another name (a replay) shows once.
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({ id: o.id, object, re: o.re, text: o.m, at: o.at });
  }
  return out.sort((x, y) => x.at - y.at);
}
