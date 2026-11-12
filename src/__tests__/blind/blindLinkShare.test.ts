/**
 * Blind tests (plan W6.15, lane B): the encrypted share link (#448).
 *
 * Written from the spec only: PR #448's body (with its review 12.11 fixes),
 * docs/src/content/docs/collab/share-link.md and the public API of
 * src/share/linkShare.ts and shareReady.ts (on the train: #473's exportReady; declarations emitted by tsc, no function
 * bodies). The test list (S1–S11) was written before any implementation was read; the
 * implementation was then opened only to check the import paths. Runs on
 * verify/train-2 and on the feat/share-link-fragment head (both modules are identical).
 * Failing cases are `it.fails` entries that link to a finding in the W6.15 findings
 * list (PR body of test/blind-tests).
 */
import { describe, expect, it } from "vitest";
import {
  EXPIRY_DAYS,
  MAX_INFLATE_RATIO,
  MAX_LINK_DATA,
  PUBLIC_APP_ORIGIN,
  SHARE_FILE_EXTENSION,
  ShareLinkError,
  createShareLink,
  fromBase64Url,
  isShareHash,
  maxInflated,
  openNote,
  parseShareHash,
  sealNote,
  shareFileData,
  shareOrigin,
  toBase64Url,
  type SharedNote,
} from "../../share/linkShare";

const ORIGIN = "https://lumen-md.vercel.app";
const MARKER = "סוד-מקור-7731";

function prose(bytes: number) {
  const parts = [
    "שורה בעברית על חדשות, מקורות ופגישות עם אנשים שאסור לנקוב בשמם. ",
    "An English line about notes, drafts and the people in them. ",
    "- [ ] משימה עם **הדגשה** ו-[[קישור]]\n",
    "| עמודה | Column |\n|---|---|\n| 1 | 2 |\n",
  ];
  let out = `# ${MARKER}\n`;
  let seed = 3;
  while (new TextEncoder().encode(out).length < bytes) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += parts[seed % parts.length] + ((seed >> 4) % 997) + " ";
  }
  return out;
}

const note = (markdown = prose(20_000), extra: Partial<SharedNote> = {}): SharedNote => ({ title: "פתק", markdown, created: 1_700_000_000_000, ...extra });

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "opened";
  } catch (e) {
    return e instanceof ShareLinkError ? e.code : `other: ${String(e)}`;
  }
}

describe("seal and open (S1)", () => {
  it("a 20 KB Hebrew and English note comes back exactly", async () => {
    const n = note();
    const s = await sealNote(n);
    expect(s.key.length).toBe(32);
    expect(await openNote(s.data, s.key)).toEqual(n);
  });

  it("every seal has its own key and IV", async () => {
    const n = note(prose(500));
    const a = await sealNote(n);
    const b = await sealNote(n);
    expect(toBase64Url(a.key)).not.toBe(toBase64Url(b.key));
    expect(toBase64Url(a.data.slice(1, 13))).not.toBe(toBase64Url(b.data.slice(1, 13)));
    expect(toBase64Url(a.data)).not.toBe(toBase64Url(b.data));
  });
});

describe("what a server receives (S2, S3)", () => {
  it("nothing of the note, its data or its key is before the '#'", async () => {
    const n = note();
    const link = await createShareLink(n, ORIGIN);
    expect(link.url).not.toBeNull();
    for (const url of [link.url!, link.urlWithoutKey!, link.fileUrl]) {
      const u = new URL(url);
      expect(u.origin).toBe(ORIGIN);
      expect(u.pathname).toBe("/");
      expect(u.search).toBe("");
      const before = url.slice(0, url.indexOf("#"));
      expect(before).toBe(`${ORIGIN}/`);
    }
    expect(link.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.url!).not.toContain(MARKER);
    expect(link.url!).not.toContain(encodeURIComponent(MARKER));
    expect(link.urlWithoutKey!).not.toContain(link.key);
    expect(link.fileUrl).toContain(link.key);
  });

  it("the three forms parse back; other fragments are not shares", async () => {
    const link = await createShareLink(note(prose(300)), ORIGIN);
    const full = parseShareHash(new URL(link.url!).hash)!;
    expect(full.key).toBe(link.key);
    expect(full.data!.length).toBe(link.dataChars);
    const keyless = parseShareHash(new URL(link.urlWithoutKey!).hash)!;
    expect(keyless.key).toBeNull();
    expect(keyless.data).toBe(full.data);
    const file = parseShareHash(new URL(link.fileUrl).hash)!;
    expect(file.data).toBeNull();
    expect(file.key).toBe(link.key);
    for (const h of [new URL(link.url!).hash, new URL(link.urlWithoutKey!).hash, new URL(link.fileUrl).hash]) expect(isShareHash(h)).toBe(true);
    for (const h of ["", "#", "#viewer", "#/notes/a", "#view-files&key=x", "#heading-view=1"]) {
      expect(isShareHash(h)).toBe(false);
      expect(parseShareHash(h)).toBeNull();
    }
    const opened = await openNote(fromBase64Url(full.data!), fromBase64Url(full.key!));
    expect(opened.title).toBe("פתק");
  });
});

describe("tampering (S4)", () => {
  it("a changed byte anywhere never opens, and never shows altered text", async () => {
    const s = await sealNote(note(prose(2000)));
    const positions = new Set<number>([0, 1, 12, 13, s.data.length - 1, s.data.length - 16]);
    for (let i = 0; i < s.data.length; i += Math.max(1, Math.floor(s.data.length / 60))) positions.add(i);
    for (const i of positions) {
      const d = s.data.slice();
      d[i] ^= 0x01;
      expect(["key", "malformed"]).toContain(await code(openNote(d, s.key)));
    }
  });

  it("a wrong key, a cut link and a wrong version are refused with the documented codes", async () => {
    const s = await sealNote(note(prose(2000)));
    const wrong = s.key.slice();
    wrong[0] ^= 0xff;
    expect(await code(openNote(s.data, wrong))).toBe("key");
    for (const cut of [0, 1, 13, 20, s.data.length - 1]) expect(["key", "malformed"]).toContain(await code(openNote(s.data.slice(0, cut), s.key)));
    const v = s.data.slice();
    v[0] = 0x02;
    expect(await code(openNote(v, s.key))).toBe("malformed");
    expect(["key", "malformed"]).toContain(await code(openNote(s.data, s.key.slice(0, 16))));
  });
});

describe("expiry (S5)", () => {
  it("opens before the date and is refused after it", async () => {
    const created = Date.UTC(2026, 10, 12);
    const n = note(prose(300), { created, expires: created + 86_400_000 });
    const s = await sealNote(n);
    expect((await openNote(s.data, s.key, created + 1000)).expires).toBe(n.expires);
    expect(await code(openNote(s.data, s.key, created + 86_400_001))).toBe("expired");
    expect(EXPIRY_DAYS).toEqual([0, 1, 7, 30]);
  });
});

describe("size (S6, S7)", () => {
  it("a note too large for a link opens from its file", async () => {
    let seed = 11;
    let text = "";
    while (text.length < 60_000) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      text += String.fromCharCode(0x5d0 + (seed % 27), 0x41 + ((seed >> 8) % 58));
    }
    const n = note(text);
    const link = await createShareLink(n, ORIGIN);
    expect(link.dataChars).toBeGreaterThan(MAX_LINK_DATA);
    expect(link.url).toBeNull();
    expect(link.urlWithoutKey).toBeNull();
    expect(SHARE_FILE_EXTENSION).toBe(".lumenshare");
    const data = shareFileData(link.file)!;
    expect(data).not.toBeNull();
    expect(await openNote(data, fromBase64Url(link.key))).toEqual(n);
    expect(shareFileData(new TextEncoder().encode("not a share file"))).toBeNull();
    expect(shareFileData(new Uint8Array())).toBeNull();
  });

  it("the inflation bound is max(MAX_LINK_DATA, compressed) × 100", () => {
    expect(MAX_INFLATE_RATIO).toBe(100);
    expect(maxInflated(10)).toBe(MAX_LINK_DATA * 100);
    expect(maxInflated(MAX_LINK_DATA * 4)).toBe(MAX_LINK_DATA * 400);
  });

  it("sealNote refuses a note that would not open under the bound", async () => {
    const huge = note("a".repeat(maxInflated(1) + 10));
    let refused = false;
    try {
      await sealNote(huge);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe("which address a link opens (S8, S9)", () => {
  const loc = (href: string) => {
    const u = new URL(href);
    return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
  };

  it("a public https page keeps its own origin", () => {
    for (const href of ["https://notes.example.org/x", "https://172.15.0.1/", "https://172.32.0.1/", "https://8.8.8.8/"]) {
      expect(shareOrigin(loc(href))).toBe(new URL(href).origin);
    }
  });

  it("desktop, mobile, localhost, private ranges and plain http name the public app", () => {
    for (const href of ["http://notes.example.org/", "https://localhost:5173/", "http://127.0.0.1/", "https://127.8.9.1/", "https://10.0.0.5/", "https://192.168.1.7/", "https://172.16.0.1/", "https://172.31.255.1/", "https://my-mac.local/", "tauri://localhost/", "https://tauri.localhost/", "capacitor://localhost/"]) {
      expect(shareOrigin(loc(href))).toBe(PUBLIC_APP_ORIGIN);
    }
    expect(shareOrigin(null)).toBe(PUBLIC_APP_ORIGIN);
  });

  it("a configured https origin is used; a configured http one is not", () => {
    expect(shareOrigin(loc("tauri://localhost/"), "https://share.example.org")).toBe("https://share.example.org");
    expect(shareOrigin(loc("tauri://localhost/"), "http://share.example.org")).toBe(PUBLIC_APP_ORIGIN);
  });

  it("IPv6 loopback, 0.0.0.0, IPv4 link-local and a decimal 127.0.0.1 name the public app (adversarial)", () => {
    for (const href of ["https://[::1]/", "https://0.0.0.0/", "https://169.254.1.1/", "https://2130706433/"]) {
      expect(shareOrigin(loc(href))).toBe(PUBLIC_APP_ORIGIN);
    }
  });

  // F-7 (Low): these non-public hosts are taken for public ones, so a link made there
  // opens for nobody else (no leak: the fragment is never sent).
  for (const href of ["https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:192.168.1.1]/", "https://localhost./", "https://100.64.0.1/", "https://nas.home.arpa/", "https://box.internal/"]) {
    it(`(F-7) ${href} names the public app`, () => {
      expect(shareOrigin(loc(href))).toBe(PUBLIC_APP_ORIGIN);
    });
  }
});

describe("base64url and the export door (S10, S11)", () => {
  it("base64url round-trips every byte value with no + / =", () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33, 256]) {
      const b = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
      const t = toBase64Url(b);
      expect(t).not.toMatch(/[+/=]/);
      expect([...fromBase64Url(t)]).toEqual([...b]);
    }
  });

  // Spec decision (coordinator, 12.11): the text is never sent unredacted. On the train the door
  // (#473's exportReadyText) is always in the build and the share command calls it directly
  // (no shareReady seam, so no "door missing" path): what the link carries is the door's text.
  it("the share command takes the export door's text: no redacted passage or hidden comment", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cmd = readFileSync(join(__dirname, "..", "..", "commands", "domains", "export.ts"), "utf8");
    expect(cmd.slice(cmd.indexOf('id: "file.shareLink"'))).toMatch(/markdown: await exportReadyText\(doc\.content, false\)/);
    const { exportReadyText } = await import("../../storage/exportReady");
    const text = await exportReadyText("plain <redact>secret name</redact> <!-- c --> text", false);
    expect(text).toContain("plain");
    expect(text).not.toContain("secret name");
    expect(text).not.toContain("<!--");
  });
});
