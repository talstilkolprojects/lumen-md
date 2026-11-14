// @vitest-environment node
/**
 * Plan W5.10 — an encrypted share link with no server (src/share/linkShare.ts).
 *
 * The acceptance "the server log holds no byte of the content or of the
 * key": everything a server can ever receive from a link is the part before
 * the #fragment (the request line; the Referer never carries a fragment).
 * These tests take that part from every link the module makes and check that
 * no byte of the note, of the data or of the key is in it. e2e/share-link.spec.ts
 * checks the same against every request a browser really sends.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createShareLink,
  fromBase64Url,
  isShareHash,
  MAX_INFLATE_RATIO,
  MAX_LINK_DATA,
  maxInflated,
  PUBLIC_APP_ORIGIN,
  shareOrigin,
  openNote,
  parseShareHash,
  sealNote,
  shareFileData,
  ShareLinkError,
  toBase64Url,
  type SharedNote,
} from "../share/linkShare";

const ORIGIN = "https://lumen-md.vercel.app";

/** A 20 KB note in Hebrew and English (the acceptance's size). */
function note20k(): string {
  const para = "# סיכום פגישה\n\nשלום, זה פתק בעברית עם **הדגשה** ו-English words, רשימה:\n\n- פריט אחד\n- item two\n\n";
  let s = "";
  for (let i = 0; s.length < 20 * 1024; i++) s += `${para}שורה ${i}: ${"מידע ".repeat(i % 7)}${i * 7919}\n\n`;
  return s.slice(0, 20 * 1024);
}

/** What a server can receive from a link: everything before the fragment. */
const serverSide = (url: string) => url.split("#")[0];

async function expectThrows(p: Promise<unknown>, code: string) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err instanceof ShareLinkError ? err.code : String(err)).toBe(code);
}

describe("share link: the note and the key stay in the fragment", () => {
  it("a 20 KB note round-trips, and fits in a link", async () => {
    const markdown = note20k();
    const created = Date.UTC(2026, 10, 12);
    const link = await createShareLink({ title: "פגישה.md", markdown, created }, ORIGIN);
    expect(link.url).not.toBeNull();
    expect(link.dataChars).toBeLessThanOrEqual(MAX_LINK_DATA);
    const parsed = parseShareHash(new URL(link.url!).hash)!;
    const opened = await openNote(fromBase64Url(parsed.data!), fromBase64Url(parsed.key!));
    expect(opened).toEqual({ title: "פגישה.md", markdown, created });
  });

  it("no byte of the note, the data or the key is in the part a server receives", async () => {
    const markdown = note20k();
    const link = await createShareLink({ title: "secret title", markdown, created: 1 }, ORIGIN);
    const parsed = parseShareHash(new URL(link.url!).hash)!;
    for (const url of [link.url!, link.urlWithoutKey!, link.fileUrl]) {
      const sent = serverSide(url);
      // The request line is the app's page itself: no path, no query.
      expect(sent).toBe(`${ORIGIN}/`);
      const u = new URL(url);
      expect(u.pathname).toBe("/");
      expect(u.search).toBe("");
      for (const secret of [parsed.data!, parsed.key!, link.key, "secret title", markdown.slice(0, 40), "סיכום"]) {
        expect(sent.includes(secret), secret.slice(0, 20)).toBe(false);
        expect(sent.includes(encodeURIComponent(secret)), secret.slice(0, 20)).toBe(false);
      }
    }
    // And the fragment itself holds the key and the data only as base64url, never the text.
    expect(link.url!.includes("secret")).toBe(false);
    expect(decodeURIComponent(link.url!).includes("סיכום")).toBe(false);
  });

  it("every link gets a fresh key and IV: the same note twice gives unrelated links", async () => {
    const n: SharedNote = { title: "a", markdown: "same text", created: 5 };
    const [a, b] = await Promise.all([sealNote(n), sealNote(n)]);
    expect(toBase64Url(a.key)).not.toBe(toBase64Url(b.key));
    expect(toBase64Url(a.data.subarray(1, 13))).not.toBe(toBase64Url(b.data.subarray(1, 13)));
    expect(toBase64Url(a.data)).not.toBe(toBase64Url(b.data));
    expect(a.key.length).toBe(32);
    expect(toBase64Url(a.key)).toHaveLength(43);
  });
});

describe("share link: opening refuses anything but the real note", () => {
  const note: SharedNote = { title: "t", markdown: "hello **world**", created: 1000 };

  it("a changed byte, a wrong key and a cut link do not open", async () => {
    const { data, key } = await sealNote(note);
    const flipped = data.slice();
    flipped[flipped.length - 5] ^= 1;
    await expectThrows(openNote(flipped, key), "key");
    const other = await sealNote(note);
    await expectThrows(openNote(data, other.key), "key");
    await expectThrows(openNote(data.subarray(0, 20), key), "malformed");
    await expectThrows(openNote(data, key.subarray(0, 16)), "key");
    const v2 = data.slice();
    v2[0] = 2;
    await expectThrows(openNote(v2, key), "malformed");
    expect(() => fromBase64Url("not base64!")).toThrow(ShareLinkError);
  });

  it("the expiry inside the payload: open before it, refused after it", async () => {
    const { data, key } = await sealNote({ ...note, expires: 2000 });
    expect((await openNote(data, key, 1999)).expires).toBe(2000);
    await expectThrows(openNote(data, key, 2001), "expired");
  });
});

describe("share link: too large for a link → an encrypted file", () => {
  it("offers the file and a key-only link; the file opens with that key", async () => {
    // Random text does not compress: well over the cap.
    const s = Array.from(crypto.getRandomValues(new Uint8Array(40_000)), (b) => String.fromCharCode(33 + (b % 90))).join("");
    const link = await createShareLink({ title: "big", markdown: s, created: 1 }, ORIGIN);
    expect(link.dataChars).toBeGreaterThan(MAX_LINK_DATA);
    expect(link.url).toBeNull();
    expect(link.urlWithoutKey).toBeNull();
    expect(link.fileUrl).toBe(`${ORIGIN}/#view-file&key=${link.key}`);
    const data = shareFileData(link.file)!;
    expect(data).not.toBeNull();
    expect((await openNote(data, fromBase64Url(link.key))).markdown).toBe(s);
    expect(shareFileData(new TextEncoder().encode("not a share file"))).toBeNull();
  });
});

describe("share link: the fragment", () => {
  it("parses the full link, the key-less link and the file link", () => {
    expect(parseShareHash("#view=abc&key=def")).toEqual({ data: "abc", key: "def" });
    expect(parseShareHash("#view=abc")).toEqual({ data: "abc", key: null });
    expect(parseShareHash("#view-file&key=def")).toEqual({ data: null, key: "def" });
    expect(parseShareHash("#room=abc")).toBeNull();
    expect(parseShareHash("#viewer")).toBeNull();
    expect(parseShareHash("")).toBeNull();
    expect(isShareHash("#view")).toBe(true);
    expect(isShareHash("#views=1")).toBe(false);
  });

  it("the boot path (src/main.tsx) recognises the same fragments", () => {
    const main = readFileSync(join(__dirname, "..", "main.tsx"), "utf8");
    const src = /const SHARE_HASH = (\/.+\/);/.exec(main)![1];
    const re = new RegExp(src.slice(1, -1));
    for (const h of ["#view=abc&key=def", "#view=abc", "#view-file&key=x", "#view", "#room=a", "#viewer", "#views=1", ""]) {
      expect(re.test(h), h).toBe(isShareHash(h));
    }
  });
});

describe("review 12.11: inflation cap, public origin, the export door", () => {
  /** Seal `json` by hand, as a crafted link would (sealNote refuses such notes). */
  async function craft(json: string): Promise<{ data: Uint8Array; key: Uint8Array }> {
    const cs = new CompressionStream("deflate-raw");
    const w = cs.writable.getWriter();
    void w.write(new TextEncoder().encode(json)).then(() => w.close());
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("lumen-share:1") }, k, compressed));
    const data = new Uint8Array(1 + 12 + ct.length);
    data[0] = 1;
    data.set(iv, 1);
    data.set(ct, 13);
    return { data, key };
  }

  it("a crafted link that inflates past the bound is refused, not inflated", async () => {
    const huge = JSON.stringify({ v: 1, t: "x", m: "a".repeat(maxInflated(0) + 1), c: 1 });
    const { data, key } = await craft(huge);
    expect(data.length).toBeLessThan(MAX_LINK_DATA); // a small link …
    await expectThrows(openNote(data, key), "malformed"); // … that would inflate to megabytes
    // Right under the bound it opens.
    const fine = await craft(JSON.stringify({ v: 1, t: "x", m: "a".repeat(maxInflated(0) - 100), c: 1 }));
    expect((await openNote(fine.data, fine.key)).markdown.length).toBe(maxInflated(0) - 100);
    expect(maxInflated(0)).toBe(MAX_LINK_DATA * MAX_INFLATE_RATIO);
  });

  it("sealNote refuses a note that would not open under the bound", async () => {
    await expectThrows(sealNote({ title: "x", markdown: "a".repeat(maxInflated(0) + 1), created: 1 }), "malformed");
  });

  it("links made in the desktop or mobile app, or on localhost, name the public app", () => {
    const at = (href: string) => {
      const u = new URL(href);
      return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
    };
    expect(shareOrigin(at("tauri://localhost/"), undefined)).toBe(PUBLIC_APP_ORIGIN);
    expect(shareOrigin(at("capacitor://localhost/"), undefined)).toBe(PUBLIC_APP_ORIGIN);
    expect(shareOrigin(at("http://localhost:5173/"), undefined)).toBe(PUBLIC_APP_ORIGIN);
    expect(shareOrigin(at("https://127.0.0.1:4443/"), undefined)).toBe(PUBLIC_APP_ORIGIN);
    expect(shareOrigin(at("https://192.168.1.20/"), undefined)).toBe(PUBLIC_APP_ORIGIN);
    expect(shareOrigin(at("http://notes.example.com/"), undefined)).toBe(PUBLIC_APP_ORIGIN);
    // A self-hosted Lumen on a public https host keeps its own links.
    expect(shareOrigin(at("https://notes.example.com/app"), undefined)).toBe("https://notes.example.com");
    // The build can name another public app; only https.
    expect(shareOrigin(at("tauri://localhost/"), "https://lumen.example.org/")).toBe("https://lumen.example.org");
    expect(shareOrigin(at("tauri://localhost/"), "http://lumen.example.org/")).toBe(PUBLIC_APP_ORIGIN);
    expect(shareOrigin(null, undefined)).toBe(PUBLIC_APP_ORIGIN);
  });

  it("IPv4-mapped IPv6 hosts are judged as their IPv4 address, in the hex form the URL parser writes (review 4)", () => {
    const at = (href: string) => {
      const u = new URL(href);
      return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
    };
    for (const href of ["https://[::ffff:192.168.1.10]/", "https://[::ffff:10.0.0.5]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:100.64.0.1]/"]) {
      expect(at(href).hostname, href).toMatch(/^\[::ffff:[0-9a-f]+:[0-9a-f]+\]$/);
      expect(shareOrigin(at(href), undefined), href).toBe(PUBLIC_APP_ORIGIN);
    }
    expect(shareOrigin(at("https://[::ffff:8.8.8.8]/"), undefined)).toBe("https://[::ffff:808:808]");
  });

  it("the share command sends the note through shareReadyText; with #473 in the build, that is the export door", async () => {
    const cmd = readFileSync(join(__dirname, "..", "commands", "domains", "export.ts"), "utf8");
    expect(cmd).toMatch(/markdown = await shareReadyText\(doc\.content\)/);
    expect(cmd).toMatch(/openShareLink\(\{ title: doc\.name, markdown \}\)/);
    // A refusal says why (review 4).
    expect(cmd).toMatch(/instanceof ExportDoorMissingError[\s\S]{0,300}uiAlert\(\{ message: t\("shareLink\.noExportDoor"\) \}\)/);
    const { hasExportDoor, shareReadyText } = await import("../share/shareReady");
    const { existsSync } = await import("node:fs");
    expect(hasExportDoor()).toBe(existsSync(join(__dirname, "..", "storage", "exportReady.ts")));
    const note = "Public. <redact>Dana Levi</redact> <!-- hidden -->";
    if (hasExportDoor()) {
      const text = await shareReadyText(note);
      expect(text).not.toContain("Dana Levi");
      expect(text).not.toContain("hidden");
      // Without the door the link is refused, never made of the raw note (review 2).
    } else await expect(shareReadyText(note)).rejects.toThrow(/no export door/);
  });
});
