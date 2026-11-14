/** T32 / T33 — read aloud and the daily digest. */
import { describe, it, expect } from "vitest";
import { langFor, speakableSentences } from "../ai/tts";
import { buildDigest, digestFolder, openTasks, writeDigest, type DigestIO } from "../agents/defs/digester";
import type { WorkspaceEntry } from "../storage/workspace";

describe("read aloud", () => {
  it("splits into sentences with source ranges, skipping frontmatter and code", () => {
    const md = "---\ntitle: x\n---\n# כותרת\n\nשלום עולם. מה נשמע?\n\n```js\nconst a = 1;\n```\nSee [the docs](https://x.y) now!";
    const s = speakableSentences(md);
    expect(s.map((x) => x.text)).toEqual(["כותרת", "שלום עולם.", "מה נשמע?", "See the docs now!"]);
    expect(md.slice(s[1].from, s[1].to)).toBe("שלום עולם.");
  });
  it("skips tilde-fenced code and CRLF frontmatter too", () => {
    const md = "---\r\ntitle: secret\r\n---\r\nHello there.\r\n\r\n~~~python\r\nprint(1)\r\n~~~\r\nBye now.";
    expect(speakableSentences(md).map((x) => x.text)).toEqual(["Hello there.", "Bye now."]);
    expect(speakableSentences("Intro.\n````\n```\nnot code end\n````\nOut.").map((x) => x.text)).toEqual(["Intro.", "Out."]);
  });
  it("picks the Hebrew voice for Hebrew sentences", () => {
    expect(langFor("שלום עולם", "en")).toBe("he-IL");
    expect(langFor("Hello", "en")).toBe("en");
  });
});

describe("digest", () => {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  it("lists changed notes newest first with their open tasks, in Hebrew", () => {
    const d = buildDigest({
      since: 0,
      now: Date.UTC(2026, 9, 18),
      lang: "he",
      formatDate: fmt,
      notes: [
        { entry: { path: "a/פגישה.md", name: "פגישה.md", size: 1, modified: 2 }, content: "# פגישת צוות\n- [ ] לשלוח סיכום\n- [x] סגור" },
        { entry: { path: "ideas.md", name: "ideas.md", size: 1, modified: 1 }, content: "plain" },
      ],
    });
    expect(d).toContain("# סיכום — 2026-10-18");
    expect(d.indexOf("[[a/פגישה|פגישה]] — פגישת צוות")).toBeLessThan(d.indexOf("[[ideas]]"));
    expect(d).toContain("- [ ] לשלוח סיכום ← [[a/פגישה|פגישה]]");
    expect(d).not.toContain("סגור ←");
  });
  it("says so when nothing changed", () => {
    expect(buildDigest({ since: 0, now: 0, lang: "en", formatDate: fmt, notes: [] })).toContain("Nothing changed");
  });
  it("finds open tasks only", () => {
    expect(openTasks("- [ ] a\n* [ ] b\n- [x] c")).toEqual(["a", "b"]);
  });
  it("ignores task and heading syntax inside fenced code", () => {
    const md = "```md\n# Not a heading\n- [ ] example\n```\n~~~\n- [ ] tilde example\n~~~\n- [ ] real";
    expect(openTasks(md)).toEqual(["real"]);
  });
  it("links same-named notes in different folders by their path", () => {
    const d = buildDigest({
      since: 0, now: 0, lang: "en", formatDate: fmt,
      notes: [
        { entry: { path: "projects/current/plan.md", name: "plan.md", size: 1, modified: 2 }, content: "- [ ] ship" },
        { entry: { path: "archive/plan.markdown", name: "plan.markdown", size: 1, modified: 1 }, content: "x" },
      ],
    });
    expect(d).toContain("[[projects/current/plan|plan]]");
    expect(d).toContain("[[archive/plan|plan]]");
    expect(d).toContain("- [ ] ship ← [[projects/current/plan|plan]]");
  });
});

describe("digest note", () => {
  const fmt = (ms: number) => String(ms);
  const entry = (path: string, modified: number): WorkspaceEntry => ({ path, name: path.split("/").pop()!, size: 1, modified });
  function vault(files: Record<string, { body: string; modified: number }>, unreadable: string[] = []) {
    const writes: Array<[string, string]> = [];
    const io: DigestIO = {
      list: async () => Object.entries(files).map(([p, f]) => entry(p, f.modified)),
      read: async (p) => {
        if (unreadable.includes(p) || !files[p]) throw new Error("gone");
        return files[p].body;
      },
      write: async (p, b) => {
        writes.push([p, b]);
        files[p] = { body: b, modified: 99 };
      },
    };
    return { io, writes, files };
  }
  const now = new Date(2026, 9, 18, 15).getTime();

  it("appends a second same-day digest instead of replacing the first (or the user's edits)", async () => {
    const v = vault({ "Digests/2026-10-18.md": { body: "# Digest — morning\n\nmy own note", modified: 5 }, "b.md": { body: "- [ ] new", modified: 20 } });
    const r = await writeDigest(v.io, { since: 10, now, lang: "en", folder: "Digests", formatDate: fmt });
    expect(r.ok && r.written).toBe(true);
    expect(v.files["Digests/2026-10-18.md"].body).toMatch(/^# Digest — morning\n\nmy own note\n\n---\n\n# Digest/);
    expect(v.files["Digests/2026-10-18.md"].body).toContain("- [ ] new ← [[b]]");
  });

  it("an empty re-run leaves the day's digest untouched", async () => {
    const v = vault({ "Digests/2026-10-18.md": { body: "earlier", modified: 5 } });
    const r = await writeDigest(v.io, { since: 10, now, lang: "en", folder: "Digests", formatDate: fmt });
    expect(r).toEqual({ ok: true, path: "Digests/2026-10-18.md", body: "earlier", written: false });
    expect(v.writes).toHaveLength(0);
  });

  it("writes nothing when a changed note can't be read, so the checkpoint can stay", async () => {
    const v = vault({ "a.md": { body: "x", modified: 20 }, "b.md": { body: "y", modified: 20 } }, ["b.md"]);
    const r = await writeDigest(v.io, { since: 10, now, lang: "en", folder: "Digests", formatDate: fmt });
    expect(r).toEqual({ ok: false, failed: ["b.md"] });
    expect(v.writes).toHaveLength(0);
  });

  it("includes .markdown notes", async () => {
    const v = vault({ "notes/idea.markdown": { body: "# Idea", modified: 20 }, "pic.png": { body: "", modified: 20 } });
    const r = await writeDigest(v.io, { since: 10, now, lang: "en", folder: "Digests", formatDate: fmt });
    expect(r.ok && r.body).toContain("[[notes/idea|idea]] — Idea");
    expect(r.ok && r.body).not.toContain("pic");
  });

  it("7.7 acceptance: two runs on one day give two sections in the same note, each with only its own changes", async () => {
    const v = vault({ "a.md": { body: "- [ ] first", modified: 20 } });
    const morning = new Date(2026, 9, 18, 9).getTime();
    const r1 = await writeDigest(v.io, { since: 10, now: morning, lang: "en", folder: digestFolder(null, "en"), formatDate: fmt });
    expect(r1.ok && r1.path).toBe("Digests/2026-10-18.md");
    v.files["Digests/2026-10-18.md"].modified = morning;
    v.files["b.md"] = { body: "- [ ] second", modified: morning + 1 };
    // The checkpoint is the first run's time; the UI switched to Hebrew in between, the stored folder stays.
    const r2 = await writeDigest(v.io, { since: morning, now: morning + 3600_000, lang: "he", folder: digestFolder("Digests", "he"), formatDate: fmt });
    expect(r2.ok && r2.path).toBe("Digests/2026-10-18.md");
    const body = v.files["Digests/2026-10-18.md"].body;
    expect(body.split("\n---\n")).toHaveLength(2);
    const [one, two] = body.split("\n---\n");
    expect(one).toContain("first");
    expect(two).toContain("second");
    expect(two).not.toContain("first");
    expect(two).not.toContain("[[Digests/");
  });

  it("the digest folder is fixed once chosen; the language picks it only the first time", () => {
    expect(digestFolder(null, "en")).toBe("Digests");
    expect(digestFolder(null, "he")).toBe("סיכומים");
    expect(digestFolder("Digests", "he")).toBe("Digests");
    expect(digestFolder("סיכומים", "en")).toBe("סיכומים");
    expect(digestFolder("../x", "en")).toBe("Digests");
    expect(digestFolder(".hidden", "en")).toBe("Digests");
  });

  it("in the other language's default folder only its day notes are skipped, the user's own notes count (#254 review)", async () => {
    const v = vault({
      "סיכומים/2026-10-17.md": { body: "- [ ] old digest task", modified: 20 },
      "סיכומים/רעיונות.md": { body: "- [ ] my own task", modified: 20 },
      "סיכומים/sub/2026-10-17.md": { body: "nested note", modified: 20 },
    });
    const r = await writeDigest(v.io, { since: 10, now, lang: "en", folder: "Digests", formatDate: fmt });
    expect(r.ok && r.body).not.toContain("old digest task");
    expect(r.ok && r.body).toContain("my own task");
    expect(r.ok && r.body).toContain("[[סיכומים/sub/2026-10-17|2026-10-17]]");
  });

  it("digests left in the other language's default folder are not counted as changed notes", async () => {
    const v = vault({ "סיכומים/2026-10-17.md": { body: "- [ ] old digest task", modified: 20 }, "a.md": { body: "x", modified: 20 } });
    const r = await writeDigest(v.io, { since: 10, now, lang: "en", folder: "Digests", formatDate: fmt });
    expect(r.ok && r.body).not.toContain("old digest task");
    expect(r.ok && r.body).toContain("[[a]]");
  });
});
