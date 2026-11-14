// @vitest-environment node
/**
 * Plan W5.21, the private classroom: sealed boxes, the classroom link, the
 * relay's append-only drop box, and a teacher with two students — then a
 * class of 30 — end to end through the real relay (sync-server/vault-relay.js)
 * over HTTP, with every request recorded and searched for plaintext.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { bucket, newKeyPair, open, pad, rawPublic, seal, SealError, unpad } from "../sync/e2ee/classroom/seal";
import { classLinkHash, ClassLinkError, fromBase64Url, isClassHash, MAX_CLASS_LINK_DATA, parseClassHash, toBase64Url } from "../sync/e2ee/classroom/link";
import {
  closeAssignment,
  commentSlot,
  createAssignment,
  dropIdOf,
  fetchComments,
  fetchSubmissions,
  joinAssignment,
  linkOf,
  sendComment,
  submit,
  type StudentAssignment,
  type TeacherAssignment,
} from "../sync/e2ee/classroom/classroom";
import { getAssignment, listAssignments, removeAssignment, saveAssignment } from "../sync/e2ee/classroom/store";
import { relayProvider } from "../sync/e2ee/providers/relay";
import { PreconditionFailedError } from "../sync/e2ee/provider";

const require = createRequire(import.meta.url);
type Relay = { handle(req: IncomingMessage, res: ServerResponse): boolean; close(): void };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vaultRelay = require("../../sync-server/vault-relay.js") as {
  createVaultRelay: (o?: Record<string, unknown>) => Relay;
  diskStore: (dir: string) => unknown;
  dropIdOf: (owner: string) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http") as typeof import("node:http");

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Everything a client sent: request line, every header, the body. */
interface Seen {
  method: string;
  url: string;
  headers: string;
  body: Buffer;
}

async function startRelay(opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lumen-class-"));
  const relay = vaultRelay.createVaultRelay({ sweep: false, ratePerMinute: 1_000_000, store: vaultRelay.diskStore(dir), ...opts });
  const seen: Seen[] = [];
  const server: Server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => seen.push({ method: req.method ?? "", url: req.url ?? "", headers: JSON.stringify(req.headers), body: Buffer.concat(chunks) }));
    if (!relay.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Every byte the relay keeps on disk. */
  const stored = () => {
    const out: Buffer[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(readFileSync(p));
      }
    };
    walk(dir);
    return out;
  };
  const stop = async () => {
    relay.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  return { origin, seen, stored, stop };
}

/** Does `needle` appear in any request or stored object — as UTF-8, UTF-16LE, URL-encoded, or base64 / base64url at any alignment? */
function leaks(needle: string, haystacks: Buffer[]): number {
  const raw = Buffer.from(needle, "utf8");
  const forms = [raw, Buffer.from(needle, "utf16le"), Buffer.from(encodeURIComponent(needle))];
  // base64 of the needle at each of the three byte offsets, minus the characters that also depend on its neighbours.
  for (const k of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(k), raw]).toString("base64");
    const core = b64.slice(k ? 4 : 0, -4);
    if (core.length >= 8) forms.push(Buffer.from(core), Buffer.from(core.replace(/\+/g, "-").replace(/\//g, "_")));
  }
  return haystacks.filter((h) => forms.some((f) => h.includes(f))).length;
}
const wire = (seen: Seen[]) => seen.flatMap((s) => [Buffer.from(`${s.method} ${s.url}`), Buffer.from(s.headers), s.body]);

describe("sealed boxes", () => {
  const me = async () => {
    const p = await newKeyPair();
    return { privateKey: p.privateKey, publicRaw: await rawPublic(p.publicKey) };
  };

  it("opens only with the recipient's key and the same context", async () => {
    const t = await me();
    const other = await me();
    const box = await seal(enc("עבודה של דנה"), t.publicRaw, { context: "sub|A" });
    expect(dec(await open(box, t, { context: "sub|A" }))).toBe("עבודה של דנה");
    await expect(open(box, other, { context: "sub|A" })).rejects.toMatchObject({ code: "open" });
    await expect(open(box, t, { context: "sub|B" })).rejects.toMatchObject({ code: "open" });
    for (const i of [1, 40, 70, box.length - 1]) {
      const bad = box.slice();
      bad[i] = (bad[i] as number) ^ 1;
      await expect(open(bad, t, { context: "sub|A" })).rejects.toBeInstanceOf(SealError);
    }
    // A fresh ephemeral key each time: the same text never seals to the same bytes.
    expect(toBase64Url(await seal(enc("x"), t.publicRaw, { context: "c" }))).not.toBe(toBase64Url(await seal(enc("x"), t.publicRaw, { context: "c" })));
  });

  it("mode 1 opens only with the right sender's public key", async () => {
    const teacher = await newKeyPair();
    const teacherPub = await rawPublic(teacher.publicKey);
    const impostor = await newKeyPair();
    const student = await me();
    const box = await seal(enc("הערה"), student.publicRaw, { context: "cmt|A", sender: teacher.privateKey });
    expect(dec(await open(box, student, { context: "cmt|A", sender: teacherPub }))).toBe("הערה");
    const forged = await seal(enc("הערה מזויפת"), student.publicRaw, { context: "cmt|A", sender: impostor.privateKey });
    await expect(open(forged, student, { context: "cmt|A", sender: teacherPub })).rejects.toMatchObject({ code: "open" });
    // An anonymous box is not accepted where a sender is required, and the other way round.
    const anon = await seal(enc("x"), student.publicRaw, { context: "cmt|A" });
    await expect(open(anon, student, { context: "cmt|A", sender: teacherPub })).rejects.toMatchObject({ code: "malformed" });
    await expect(open(box, student, { context: "cmt|A" })).rejects.toMatchObject({ code: "malformed" });
  });

  it("pads to size buckets and back", () => {
    expect([0, 1020, 1021, 5000, 200_000, 262_140, 262_141, 600_000].map(bucket)).toEqual([1024, 1024, 2048, 8192, 262_144, 262_144, 524_288, 786_432]);
    for (const n of [0, 1, 1020, 1021, 70_000]) {
      const b = crypto.getRandomValues(new Uint8Array(Math.min(n, 65536)));
      expect(toBase64Url(unpad(pad(b)))).toBe(toBase64Url(b));
    }
    expect(() => unpad(Uint8Array.of(0, 0, 9, 9, 1))).toThrow(SealError);
  });
});

describe("classroom link", () => {
  const link = { title: "שיעורי בית 3", template: "# שאלה 1\n\nענו כאן.", teacherKey: "B".repeat(87), relay: "https://relay.example.com", drop: "d".repeat(43) };

  it("round-trips through the #fragment and refuses anything else", async () => {
    const hash = await classLinkHash(link);
    expect(isClassHash(hash)).toBe(true);
    expect(await parseClassHash(hash)).toEqual(link);
    expect(isClassHash("#view=abc")).toBe(false);
    for (const bad of ["#class=", "#class=***", "#class=AAAA", hash.slice(0, -6)]) await expect(parseClassHash(bad)).rejects.toBeInstanceOf(ClassLinkError);
    await expect(classLinkHash({ ...link, relay: "javascript:alert(1)" }).then(parseClassHash)).rejects.toMatchObject({ code: "malformed" });
    await expect(classLinkHash({ ...link, drop: "short" }).then(parseClassHash)).rejects.toMatchObject({ code: "malformed" });
  });

  it("caps the link at the size of a W5.10 share link", async () => {
    const noise = toBase64Url(crypto.getRandomValues(new Uint8Array(30_000)));
    await expect(classLinkHash({ ...link, template: noise })).rejects.toMatchObject({ code: "tooLarge" });
    expect(MAX_CLASS_LINK_DATA).toBe(32 * 1024);
  });
});

describe("relay drop box (append-only)", () => {
  let r: Awaited<ReturnType<typeof startRelay>>;
  beforeAll(async () => {
    r = await startRelay({ maxDropObjectBytes: 4096, maxDropCount: 5 });
  });
  afterAll(() => r.stop());

  it("the app and the relay derive the same drop box id from an owner token", async () => {
    const owner = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    expect(await dropIdOf(owner)).toBe(vaultRelay.dropIdOf(owner));
    expect(await dropIdOf(owner)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("a link holder can add and read, never replace or delete; the owner can", async () => {
    const owner = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const drop = await dropIdOf(owner);
    const student = relayProvider({ url: r.origin, token: `a.${drop}` });
    const teacher = relayProvider({ url: r.origin, token: `o.${owner}` });
    await student.put("s-one", enc("first"), { ifNoneMatch: "*" });
    expect(await teacher.list()).toEqual(["s-one"]);
    expect(dec((await student.get("s-one"))!.data)).toBe("first");

    const raw = (init: RequestInit, name = "s-one", token = `a.${drop}`) =>
      fetch(`${r.origin}/v1/vault/o/${name}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });
    expect((await raw({ method: "PUT", body: "overwritten" })).status).toBe(403);
    const etag = (await student.get("s-one"))!.etag;
    expect((await raw({ method: "PUT", body: "overwritten", headers: { "If-Match": etag } })).status).toBe(403);
    await expect(student.put("s-one", enc("again"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await raw({ method: "DELETE" })).status).toBe(403);
    expect(dec((await teacher.get("s-one"))!.data)).toBe("first");

    // Not the owner token's own space, and not the drop id used as a private token.
    expect(await relayProvider({ url: r.origin, token: owner }).list()).toEqual([]);
    expect(await relayProvider({ url: r.origin, token: drop }).list()).toEqual([]);
    expect((await raw({ method: "GET" }, "", "x.".concat(drop))).status).toBe(401);

    await teacher.put("s-one", enc("owner may"));
    await teacher.delete("s-one");
    expect(await student.list()).toEqual([]);
  });

  it("caps a drop box's object size and count", async () => {
    const drop = await dropIdOf(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
    const p = relayProvider({ url: r.origin, token: `a.${drop}` });
    await expect(p.put("s-big", new Uint8Array(5000), { ifNoneMatch: "*" })).rejects.toThrow(/413/);
    for (let i = 0; i < 5; i++) await p.put(`s-${i}`, new Uint8Array(10), { ifNoneMatch: "*" });
    await expect(p.put("s-6", new Uint8Array(10), { ifNoneMatch: "*" })).rejects.toThrow(/507/);
  });
});

describe("a teacher and two students, through the real relay over HTTP", () => {
  it("each sees only their own work and comments; no request and no stored byte holds plaintext", async () => {
    const r = await startRelay();
    try {
      const secrets = {
        template: "תבנית: כתבו חיבור על ירושלים",
        dana: "החיבור של דנה: ירושלים של זהב",
        yossi: "Yossi's essay about the Kinneret",
        nameDana: "דנה כהן",
        nameYossi: "Yossi Levi",
        toDana: "דנה, פסקה שנייה מצוינת",
        toYossi: "Yossi: cite your sources",
      };
      const { assignment: teacher, link } = await createAssignment({ title: "חיבור", template: secrets.template, relay: r.origin });
      const parsed = await parseClassHash(await classLinkHash(link));
      expect(parsed).toEqual(linkOf(teacher));
      expect(JSON.stringify(parsed)).not.toContain(teacher.owner);

      let dana = await joinAssignment(parsed, secrets.nameDana);
      let yossi = await joinAssignment(parsed, secrets.nameYossi);
      // Joining sends nothing: a student's copy and drafts stay in their note until "hand in".
      expect(r.seen).toHaveLength(0);

      dana = await submit(dana, `${secrets.template}\n\n${secrets.dana}`);
      yossi = await submit(yossi, `${secrets.template}\n\n${secrets.yossi}`);
      dana = await submit(dana, `${secrets.template}\n\n${secrets.dana} (מתוקן)`);
      expect(dana.sent.map((s) => s.version)).toEqual([1, 2]);

      const { submissions, unreadable } = await fetchSubmissions(teacher);
      expect(unreadable).toBe(0);
      expect(submissions.map((s) => [s.name, s.version])).toEqual([
        [secrets.nameYossi, 1],
        [secrets.nameDana, 2],
        [secrets.nameDana, 1],
      ]);
      expect(submissions[1]!.markdown).toContain(`${secrets.dana} (מתוקן)`);

      // A student holds every box in the drop box, and opens none of them.
      const box = relayProvider({ url: r.origin, token: `a.${yossi.id}` });
      const names = (await box.list()).filter((n) => n.startsWith("s-"));
      expect(names).toHaveLength(3);
      let opened = 0;
      for (const n of names) {
        const data = (await box.get(n))!.data;
        await open(data, { privateKey: yossi.key, publicRaw: fromBase64Url(yossi.pub) }, { context: `sub|${yossi.id}` }).then(
          () => opened++,
          () => undefined,
        );
      }
      expect(opened).toBe(0);
      // …nor replaces or deletes Dana's.
      const danaObject = dana.sent[0]!.object;
      expect((await fetch(`${r.origin}/v1/vault/o/${danaObject}`, { method: "DELETE", headers: { Authorization: `Bearer a.${yossi.id}` } })).status).toBe(403);
      expect((await fetch(`${r.origin}/v1/vault/o/${danaObject}`, { method: "PUT", body: "x", headers: { Authorization: `Bearer a.${yossi.id}` } })).status).toBe(403);

      const danaSub = submissions.find((s) => s.name === secrets.nameDana)!;
      const yossiSub = submissions.find((s) => s.name === secrets.nameYossi)!;
      await sendComment(teacher, danaSub, secrets.toDana);
      await sendComment(teacher, yossiSub, secrets.toYossi);

      expect((await fetchComments(dana)).map((c) => [c.text, c.re])).toEqual([[secrets.toDana, danaSub.object]]);
      expect((await fetchComments(yossi)).map((c) => c.text)).toEqual([secrets.toYossi]);

      // Yossi learns Dana's slot somehow and forges a "teacher" comment there: it does not show.
      const pair = await newKeyPair();
      const forged = await seal(pad(enc(JSON.stringify({ v: 1, kind: "cmt", a: dana.id, to: dana.pub, id: "f", re: danaSub.object, m: "forged", at: 1 }))), fromBase64Url(dana.pub), {
        context: `cmt|${dana.id}`,
        sender: pair.privateKey,
      });
      await box.put(`${await commentSlot(dana.id, dana.pub)}forged`, forged, { ifNoneMatch: "*" });
      // A replay of the teacher's own comment under another name shows once.
      const teacherBox = relayProvider({ url: r.origin, token: `o.${teacher.owner}` });
      const slot = await commentSlot(dana.id, dana.pub);
      const original = (await teacherBox.list()).find((n) => n.startsWith(slot) && !n.endsWith("forged"))!;
      await teacherBox.put(`${slot}replayed`, (await teacherBox.get(original))!.data, { ifNoneMatch: "*" });
      expect((await fetchComments(dana)).map((c) => c.text)).toEqual([secrets.toDana]);

      // Not one plaintext byte on the wire, nor on the relay's disk.
      const haystacks = [...wire(r.seen), ...r.stored()];
      // The search itself finds plaintext when it is there (UTF-8, base64, URL-encoded).
      expect(leaks(secrets.dana, [Buffer.from(`x${secrets.dana}x`)])).toBe(1);
      expect(leaks(secrets.yossi, [Buffer.from(Buffer.from(`--${secrets.yossi}--`).toString("base64"))])).toBeGreaterThan(0);
      expect(leaks(secrets.nameDana, [Buffer.from(`/v1/vault/o/${encodeURIComponent(secrets.nameDana)}`)])).toBe(1);
      expect(r.seen.length).toBeGreaterThan(15);
      for (const [what, text] of Object.entries(secrets)) expect(leaks(text, haystacks), what).toBe(0);
      for (const word of ["ירושלים", "Kinneret", "דנה", "Yossi", "חיבור", "sources"]) expect(leaks(word, haystacks), word).toBe(0);
      // The owner token never left the teacher's device either.
      expect(leaks(teacher.owner, wire(r.seen.filter((s) => !s.headers.includes(`o.${teacher.owner}`))))).toBe(0);
      // Every stored box is padded: sizes are multiples of 1 KiB plus the box overhead.
      for (const b of r.stored()) expect((b.length - 2 - 65 - 12 - 16) % 1024).toBe(0);

      expect(await closeAssignment(teacher)).toBe(7);
      expect(await box.list()).toEqual([]);
    } finally {
      await r.stop();
    }
  });
});

describe("a class of 30", () => {
  it("0 students can read another's work or comments; the teacher reads all 30", async () => {
    const r = await startRelay();
    try {
      const { assignment: teacher, link } = await createAssignment({ title: "מבחן", template: "# מבחן", relay: r.origin });
      let students: StudentAssignment[] = await Promise.all(Array.from({ length: 30 }, (_, i) => joinAssignment(link, `תלמיד ${i + 1}`)));
      students = await Promise.all(students.map((s, i) => submit(s, `# מבחן\n\nתשובה סודית מספר ${i + 1}`)));

      const { submissions } = await fetchSubmissions(teacher);
      expect(submissions).toHaveLength(30);
      expect(new Set(submissions.map((s) => s.student)).size).toBe(30);
      for (const [i, s] of students.entries()) expect(submissions.find((x) => x.student === s.pub)!.markdown).toContain(`תשובה סודית מספר ${i + 1}`);

      for (const sub of submissions) await sendComment(teacher, sub, `הערה ל${sub.name}`);

      let crossReads = 0;
      const all = relayProvider({ url: r.origin, token: `a.${teacher.id}` });
      const objects = await all.list();
      expect(objects).toHaveLength(60);
      const boxes = await Promise.all(objects.map(async (n) => ({ n, data: (await all.get(n))!.data })));
      for (const s of students) {
        const me = { privateKey: s.key, publicRaw: fromBase64Url(s.pub) };
        for (const { data } of boxes) {
          for (const opts of [{ context: `sub|${s.id}` }, { context: `cmt|${s.id}`, sender: fromBase64Url(s.teacherKey) }]) {
            const text = await open(data, me, opts).then(dec, () => null);
            if (text !== null && !text.includes(`הערה ל${s.name}"`)) crossReads++;
          }
        }
        const mine = await fetchComments(s);
        expect(mine.map((c) => c.text)).toEqual([`הערה ל${s.name}`]);
      }
      expect(crossReads).toBe(0);

      const haystacks = [...wire(r.seen), ...r.stored()];
      for (let i = 1; i <= 30; i++) expect(leaks(`תשובה סודית מספר ${i}`, haystacks)).toBe(0);
      expect(leaks("תלמיד", haystacks)).toBe(0);
      expect(leaks("הערה", haystacks)).toBe(0);
    } finally {
      await r.stop();
    }
  });
});

describe("assignments on this device", () => {
  it("keeps teacher and student records apart, keys included", async () => {
    const { assignment, link } = await createAssignment({ title: "t", template: "x", relay: "https://r.example" });
    const student = await joinAssignment(link, "me");
    await saveAssignment(assignment);
    await saveAssignment(student);
    expect(((await getAssignment("teacher", assignment.id)) as TeacherAssignment).owner).toBe(assignment.owner);
    expect(((await getAssignment("student", assignment.id)) as StudentAssignment).pub).toBe(student.pub);
    expect((await listAssignments()).map((a) => a.role).sort()).toEqual(["student", "teacher"]);
    expect(assignment.key.extractable).toBe(false);
    expect(student.key.extractable).toBe(false);
    await removeAssignment(student);
    await removeAssignment(assignment);
    expect(await listAssignments()).toEqual([]);
  });
});
