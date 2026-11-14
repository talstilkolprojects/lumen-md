/**
 * The vault's MCP server and CLI (plan W2.3): off by default, scopes per
 * client, writes only through the approval queue, everything in the
 * ledger, search under 300 ms on 10,000 notes. Drives the same tool
 * handler the stdio server uses (mcp-server/src/vault/tools.ts); the real
 * stdio session is `npm --prefix mcp-server run test:stdio`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { callTool, listToolsFor, TOOLS } from "../../mcp-server/src/vault/tools";
import { enableClient, disableClient, readConfig, normalizeClientId } from "../../mcp-server/src/vault/config";
import { readLedger } from "../../mcp-server/src/vault/ledger";
import { approvePending, listPending, rejectPending } from "../../mcp-server/src/vault/pending";
import { VaultIndex, wordTerms } from "../../mcp-server/src/vault/search";
import { safeRel } from "../../mcp-server/src/vault/paths";
import { runVaultCli } from "../../mcp-server/src/cli";

let vault: string;
const note = (rel: string, text: string) => {
  const abs = path.join(vault, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
};
const read = (rel: string) => readFileSync(path.join(vault, rel), "utf8");
const ctx = (client = "claude-desktop") => ({ vault, client, index: new VaultIndex(vault) });
const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), "lumen-mcp-"));
  note("projects/launch.md", "# Launch plan\n\nShip the beta on Monday.\n");
  note("he/פרויקט.md", "---\ntags: [עבודה, plan]\n---\n# פרויקט אלפא\n\nבפרויקט הזה נבדוק את המנוע.\n");
  note("links.md", "See [[launch]] and [[פרויקט]].\n");
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("off by default, explicit per client", () => {
  it("a client that was never enabled gets no tools and every call is refused and logged", async () => {
    expect(await listToolsFor(vault, "claude-desktop")).toEqual([]);
    const r = await callTool(ctx(), "search_notes", { query: "launch" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("lumen mcp enable claude-desktop");
    const log = await readLedger(vault);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ client: "claude-desktop", tool: "search_notes", decision: "denied", bytesOut: 0 });
  });

  it("enabling one client does not enable another; scopes limit the tools", async () => {
    await enableClient(vault, "Claude Desktop", ["search", "read"]);
    expect((await listToolsFor(vault, "claude-desktop")).map((t) => t.scope)).not.toContain("propose");
    expect(await listToolsFor(vault, "cursor")).toEqual([]);
    expect((await callTool(ctx("cursor"), "read_note", { path: "links.md" })).isError).toBe(true);
    const ok = await callTool(ctx(), "read_note", { path: "links.md" });
    expect(textOf(ok)).toContain("[[launch]]");
    const w = await callTool(ctx(), "create_note", { path: "new.md", content: "x" });
    expect(w.isError).toBe(true);
    expect(textOf(w)).toContain("'propose' scope");
    expect(existsSync(path.join(vault, "new.md"))).toBe(false);
  });

  it("disabling takes effect on the next call", async () => {
    await enableClient(vault, "claude-code", ["search"]);
    expect((await callTool(ctx("claude-code"), "search_notes", { query: "beta" })).isError).toBeFalsy();
    await disableClient(vault, "claude-code");
    expect((await callTool(ctx("claude-code"), "search_notes", { query: "beta" })).isError).toBe(true);
    expect((await readConfig(vault)).clients["claude-code"].enabled).toBe(false);
  });

  it("client ids are normalised", () => {
    expect(normalizeClientId("Claude Desktop ")).toBe("claude-desktop");
    expect(normalizeClientId("")).toBe("unknown");
  });
});

describe("paths stay in the vault and out of .lumen", () => {
  it("refuses .., absolute paths and dot folders", async () => {
    await enableClient(vault, "c", ["read", "propose"]);
    for (const p of ["../etc/passwd", "/etc/passwd", ".lumen/mcp.json", "a/../../x.md", ".lumen/mcp/pending/x.json"]) {
      expect((await callTool(ctx("c"), "read_note", { path: p })).isError, p).toBe(true);
      expect((await callTool(ctx("c"), "write_note", { path: p, content: "x" })).isError, p).toBe(true);
    }
    expect(safeRel("./a/b.md")).toBe("a/b.md");
    expect(await listPending(vault)).toEqual([]);
  });

  it("follows no link out of the vault or into .lumen, for reads and approved writes (review 21, M1)", async () => {
    await enableClient(vault, "c", ["read", "propose"]);
    const outside = mkdtempSync(path.join(tmpdir(), "lumen-mcp-out-"));
    try {
      writeFileSync(path.join(outside, "secret.md"), "OUTSIDE-SECRET\n", "utf8");
      symlinkSync(path.join(vault, ".lumen"), path.join(vault, "cfg"), "dir");
      symlinkSync(outside, path.join(vault, "elsewhere"), "dir");
      symlinkSync(path.join(outside, "secret.md"), path.join(vault, "alias.md"), "file");
      symlinkSync(path.join(vault, "projects"), path.join(vault, "inside"), "dir");
      for (const p of ["cfg/mcp.json", "elsewhere/secret.md", "alias.md"]) {
        const r = await callTool(ctx("c"), "read_note", { path: p });
        expect(r.isError, p).toBe(true);
        expect(textOf(r), p).not.toContain("OUTSIDE-SECRET");
        expect(textOf(r), p).not.toContain("\"enabled\"");
        expect((await callTool(ctx("c"), "write_note", { path: p, content: "x" })).isError, p).toBe(true);
      }
      // A link that stays inside the vault is an ordinary note.
      expect(textOf(await callTool(ctx("c"), "read_note", { path: "inside/launch.md" }))).toContain("Launch plan");
      // A link made after the proposal: the approval refuses and writes nothing outside.
      expect((await callTool(ctx("c"), "create_note", { path: "later/x", content: "PLANTED\n" })).isError).toBeFalsy();
      const [p] = await listPending(vault);
      symlinkSync(outside, path.join(vault, "later"), "dir");
      await expect(approvePending(vault, p.id)).rejects.toThrow(/outside the vault/);
      expect(existsSync(path.join(outside, "x.md"))).toBe(false);
      // The CLI's direct write takes the same path.
      const io = { cwd: vault, env: {}, out: () => undefined, err: () => undefined, isTTY: false } as unknown as Parameters<typeof runVaultCli>[1];
      expect(await runVaultCli(["new", "elsewhere/y", "--vault", vault], io).catch(() => 1)).not.toBe(0);
      expect(existsSync(path.join(outside, "y.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("writes from a client wait for approval", () => {
  beforeEach(async () => {
    await enableClient(vault, "claude-desktop", ["search", "read", "propose"]);
  });

  it("create_note writes nothing until approved, then writes exactly the proposal", async () => {
    const r = await callTool(ctx(), "create_note", { path: "inbox/idea", content: "# Idea\n" });
    expect(r.isError).toBeFalsy();
    expect(existsSync(path.join(vault, "inbox/idea.md"))).toBe(false);
    const [p] = await listPending(vault);
    expect(p).toMatchObject({ client: "claude-desktop", tool: "create_note", path: "inbox/idea.md", before: null, after: "# Idea\n" });
    expect((await approvePending(vault, p.id)).status).toBe("applied");
    expect(read("inbox/idea.md")).toBe("# Idea\n");
    expect(await listPending(vault)).toEqual([]);
  });

  it("append / write / frontmatter proposals leave the note unchanged; reject drops them", async () => {
    const before = read("projects/launch.md");
    await callTool(ctx(), "append_note", { path: "projects/launch.md", content: "- one more" });
    await callTool(ctx(), "write_note", { path: "projects/launch.md", content: "gone" });
    await callTool(ctx(), "update_frontmatter", { path: "projects/launch.md", set: { status: "done" } });
    expect(read("projects/launch.md")).toBe(before);
    const list = await listPending(vault);
    expect(list.map((p) => p.tool)).toEqual(["append_note", "write_note", "update_frontmatter"]);
    expect(list[0].after).toBe(before + "- one more");
    expect(list[2].after).toBe("---\nstatus: done\n---\n" + before);
    for (const p of list) await rejectPending(vault, p.id);
    expect(read("projects/launch.md")).toBe(before);
    expect(await listPending(vault)).toEqual([]);
  });

  it("approving after the note changed is a conflict and writes nothing", async () => {
    await callTool(ctx(), "append_note", { path: "projects/launch.md", content: "- agent line" });
    note("projects/launch.md", "edited by me\n");
    const [p] = await listPending(vault);
    const res = await approvePending(vault, p.id);
    expect(res.status).toBe("conflict");
    expect(read("projects/launch.md")).toBe("edited by me\n");
  });

  it("the ledger has every call and decision, with sizes, never the text", async () => {
    await callTool(ctx(), "search_notes", { query: "beta" });
    await callTool(ctx(), "read_note", { path: "projects/launch.md" });
    await callTool(ctx(), "create_note", { path: "secret.md", content: "TOP-SECRET-BODY" });
    const [p] = await listPending(vault);
    await approvePending(vault, p.id, "test");
    const log = await readLedger(vault);
    expect(log.map((e) => `${e.tool}:${e.decision}`)).toEqual(["search_notes:allowed", "read_note:allowed", "create_note:proposed", "create_note:approved"]);
    expect(log[1].bytesOut).toBe(Buffer.byteLength(read("projects/launch.md")));
    expect(log[1].path).toBe("projects/launch.md");
    const raw = readFileSync(path.join(vault, ".lumen/mcp/ledger.jsonl"), "utf8");
    expect(raw).not.toContain("TOP-SECRET-BODY");
    expect(raw).not.toContain("beta");
  });

  it("every tool has a scope", () => {
    for (const t of TOOLS) expect(["search", "read", "propose"]).toContain(t.scope);
    expect(TOOLS.filter((t) => t.scope === "propose").map((t) => t.name).sort()).toEqual(["append_note", "bases_update", "create_note", "update_frontmatter", "write_note"]);
  });
});

describe("search", () => {
  it("finds Hebrew with a prefix letter and without, English, and tags/backlinks", async () => {
    await enableClient(vault, "c", ["search", "read"]);
    expect(wordTerms("בפרויקט")).toEqual(["בפרויקט", "פרויקט"]);
    const he = textOf(await callTool(ctx("c"), "search_notes", { query: "פרויקט" }));
    expect(he.split("\n")[0]).toContain("he/פרויקט.md");
    expect(textOf(await callTool(ctx("c"), "search_notes", { query: "ship beta" }))).toContain("projects/launch.md");
    expect(textOf(await callTool(ctx("c"), "search_notes", { query: "ship nothing-here" }))).toContain("No notes match");
    expect(textOf(await callTool(ctx("c"), "list_tags", {}))).toContain("עבודה\t1");
    expect(textOf(await callTool(ctx("c"), "get_backlinks", { path: "projects/launch.md" }))).toBe("links.md");
  });

  it("10,000 notes: a search after the index is built takes < 300 ms, including the check for changes", async () => {
    const words = ["alpha", "beta", "gamma", "delta", "שלום", "עולם", "פגישה", "תקציב", "release", "design"];
    for (let i = 0; i < 10_000; i++) {
      note(`bulk/${i % 50}/n${i}.md`, `# Note ${i}\n\n${words[i % 10]} ${words[(i * 7) % 10]} item${i} ${"lorem ipsum dolor ".repeat(20)}\n`);
    }
    const index = new VaultIndex(vault);
    await index.refresh();
    expect(index.size).toBe(10_003);
    note("bulk/fresh.md", "# Fresh\n\nתקציב חדש item-fresh\n");
    const times: number[] = [];
    let hits: Awaited<ReturnType<VaultIndex["search"]>> = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      hits = await index.search("תקציב", 20);
      times.push(performance.now() - t0);
    }
    expect(hits.length).toBe(20);
    expect(index.size).toBe(10_004);
    console.info(`[W2.3] 10,004 notes: search incl. refresh ${times.map((t) => t.toFixed(0)).join(" / ")} ms`);
    expect(Math.min(...times)).toBeLessThan(300);
    const t1 = performance.now();
    index.searchLoaded("release design", 20);
    expect(performance.now() - t1).toBeLessThan(50);
  }, 120_000);
});

describe("lumen CLI", () => {
  const run = async (args: string[], now = new Date(2026, 10, 10, 9, 5), person: { tty?: boolean; answer?: string } = { tty: true, answer: "yes" }) => {
    const out: string[] = [];
    const err: string[] = [];
    const opened: string[] = [];
    const asked: string[] = [];
    const code = await runVaultCli([...args, "--vault", vault], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: {},
      cwd: "/",
      now: () => now,
      openFile: (f) => opened.push(f),
      tty: person.tty,
      ask: async (q) => (asked.push(q), person.answer ?? ""),
    });
    return { code, out, err, opened };
  };

  it("search, open, new, append, daily", async () => {
    expect((await run(["search", "beta"])).out[0]).toMatch(/^projects\/launch\.md\tLaunch plan\t/);
    expect((await run(["search", "zzz"])).code).toBe(3);
    expect((await run(["open", "launch", "--print"])).out[0]).toContain("Ship the beta");
    const o = await run(["open", "projects/launch.md"]);
    expect(o.opened[0]).toBe(path.join(vault, "projects/launch.md"));
    expect((await run(["new", "ideas/one", "first", "line"])).out).toEqual(["ideas/one.md"]);
    expect(read("ideas/one.md")).toBe("first line\n");
    expect((await run(["new", "ideas/one"])).code).toBe(1);
    await run(["append", "ideas/one.md", "second"]);
    expect(read("ideas/one.md")).toBe("first line\nsecond\n");
    expect((await run(["daily", "call", "Dana"])).out).toEqual(["journal/2026-11-10.md"]);
    await run(["daily", "שיחה", "עם", "רון"], new Date(2026, 10, 10, 14, 30));
    expect(read("journal/2026-11-10.md")).toBe("# 2026-11-10\n- 09:05 call Dana\n- 14:30 שיחה עם רון\n");
    const log = await readLedger(vault);
    expect(log.every((e) => e.client === "cli" && e.decision === "written")).toBe(true);
  });

  it("mcp enable / status / review / approve / reject / log", async () => {
    expect((await run(["mcp", "status"])).out[0]).toContain("MCP access is off");
    expect((await run(["mcp", "enable", "cursor", "--scopes", "search,bogus"])).code).toBe(1);
    expect((await run(["mcp", "enable", "cursor", "--scopes", "search,read,propose"])).out[0]).toContain("wait for your approval");
    await callTool(ctx("cursor"), "append_note", { path: "links.md", content: "added" });
    await callTool(ctx("cursor"), "create_note", { path: "x.md", content: "x" });
    const review = await run(["mcp", "review"]);
    expect(review.out.join("\n")).toContain("+ added");
    const [first, second] = await listPending(vault);
    // Review 21 (B1): no TTY, or anything but "yes", writes nothing; --all is gone.
    expect((await run(["mcp", "approve", first.id], undefined, { tty: false })).code).toBe(1);
    expect((await run(["mcp", "approve", first.id], undefined, { tty: true, answer: "y" })).out.at(-1)).toContain("left in the queue");
    expect((await run(["mcp", "approve", "--all"])).code).toBe(1);
    expect(read("links.md")).not.toContain("added");
    const ok = await run(["mcp", "approve", first.id]);
    expect(ok.out.some((l) => l === "+ added")).toBe(true); // the diff came first
    expect(ok.out.at(-1)).toBe(`wrote links.md (${first.id})`);
    expect(read("links.md")).toContain("added");
    await run(["mcp", "reject", "--all"]);
    expect(existsSync(path.join(vault, "x.md"))).toBe(false);
    expect((await run(["mcp", "approve", second.id])).code).toBe(1);
    expect((await run(["mcp", "log"])).out.some((l) => l.includes("\trejected\t"))).toBe(true);
  });

  it("a bad command prints the usage", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("usage: lumen search");
  });
});
