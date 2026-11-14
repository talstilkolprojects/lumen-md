/**
 * Plan W8.1 — Bases over MCP and the CLI: `bases_query` / `bases_update`
 * in the vault's MCP server and `lumen bases query|update`, through the
 * same approval queue as every other outside write.
 *
 * Acceptance: MCP and the CLI return the same rows as the app on 10,000
 * rows; 0 writes without approval (a rejected update writes nothing).
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as appBases from "../views/bases/api";
import { setBasesEngine, readBatch } from "../../mcp-server/src/vault/bases";
import { callTool, TOOLS } from "../../mcp-server/src/vault/tools";
import { enableClient } from "../../mcp-server/src/vault/config";
import { approvePending, listPending, rejectPending } from "../../mcp-server/src/vault/pending";
import { VaultIndex } from "../../mcp-server/src/vault/search";
import { runVaultCli } from "../../mcp-server/src/cli";
import { McpEndpoint, META } from "../../mcp-server/src/protocol";

let vault: string;
const files = new Map<string, string>();
const put = (rel: string, text: string) => {
  files.set(rel, text);
  const abs = path.join(vault, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
};
const read = (rel: string) => readFileSync(path.join(vault, rel), "utf8");
const ctx = (client = "claude-code") => ({ vault, client, index: new VaultIndex(vault) });
const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

function cli(args: string[], person: { tty?: boolean; answer?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return runVaultCli([...args, "--vault", vault], { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, cwd: vault, tty: person.tty, ask: async () => person.answer ?? "" }).then((code) => ({ code, out, err }));
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".lumen") continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[path.relative(vault, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(vault);
  return out;
}

/** The app's side: the engine on an in-memory copy, with the app's file list (no dot folders). */
const appDeps = () => ({
  paths: async () => [...files.keys()].filter((p) => !p.split("/").some((s) => s.startsWith("."))),
  readText: async (p: string) => {
    const t = files.get(p);
    if (t === undefined) throw new Error(`no ${p}`);
    return t;
  },
});

const TASKS_BASE = `filters: file.inFolder("Tasks")
formulas:
  score: 'priority * 2 + (if(status == "doing", 1, 0))'
views:
  - type: table
    name: Open
    filters: 'status != "done"'
    order: [file.name, status, priority, formula.score, tags]
    sort:
      - property: priority
        direction: DESC
  - type: table
    name: All
    order: [file.name, status]
`;
const task = (status: string, priority: number, tags: string[] = []) => `---\nstatus: ${status}\npriority: ${priority}\ntags: [${tags.join(", ")}]\n---\n# Task\n`;

beforeAll(() => setBasesEngine(appBases));

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), "lumen-bases-mcp-"));
  files.clear();
  put("Tasks.base", TASKS_BASE);
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("bases over MCP: tools", () => {
  it("adds bases_query (read) and bases_update (propose) at the end, keeping the order fixed", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.slice(-2)).toEqual(["bases_query", "bases_update"]);
    expect(TOOLS.find((t) => t.name === "bases_query")!.scope).toBe("read");
    expect(TOOLS.find((t) => t.name === "bases_update")!.scope).toBe("propose");
  });

  it("refuses a client without the read scope, and paths outside the vault or not a .base", async () => {
    put("Tasks/a.md", task("todo", 1));
    await enableClient(vault, "claude-code", ["search"]);
    expect((await callTool(ctx(), "bases_query", { base: "Tasks.base" })).isError).toBe(true);
    await enableClient(vault, "claude-code", ["search", "read"]);
    for (const base of ["../x.base", ".lumen/x.base", "Tasks/a.md"]) expect((await callTool(ctx(), "bases_query", { base })).isError).toBe(true);
  });
});

describe("the same rows as the app on 10,000 rows", () => {
  it("MCP bases_query and `lumen bases query --json` equal the app's queryBase, for two views", async () => {
    const statuses = ["todo", "doing", "done", "waiting"];
    for (let i = 0; i < 10_000; i++) put(`Tasks/${String(i % 40).padStart(2, "0")}/t${i}.md`, task(statuses[i % 4]!, (i * 7) % 13, i % 3 ? ["x"] : ["x", "עברית"]));
    put("Other/ignored.md", task("todo", 99));
    put(".hidden/Tasks/secret.md", task("todo", 100));
    await enableClient(vault, "claude-code", ["search", "read"]);
    for (const view of ["Open", "All"]) {
      const app = await appBases.queryBase(appDeps(), "Tasks.base", view);
      const viaMcp = JSON.parse(textOf(await callTool(ctx(), "bases_query", { base: "Tasks.base", view, limit: 10_000 })));
      const viaCli = await cli(["bases", "query", "Tasks.base", "--view", view, "--json", "--limit", "10000"]);
      expect(viaCli.code).toBe(0);
      expect(app.total).toBe(view === "Open" ? 7500 : 10_000);
      expect(viaMcp).toEqual(JSON.parse(JSON.stringify(app)));
      expect(JSON.parse(viaCli.out[0]!)).toEqual(viaMcp);
    }
    // 10,000 files written and read four times from disk.
  }, 300_000);

  it("MCP pages with offset/limit (default 200) the way the app does", async () => {
    for (let i = 0; i < 500; i++) put(`Tasks/t${i}.md`, task("todo", i % 5));
    await enableClient(vault, "claude-code", ["read"]);
    const first = JSON.parse(textOf(await callTool(ctx(), "bases_query", { base: "Tasks.base" })));
    expect(first.rows).toHaveLength(200);
    expect(first.total).toBe(500);
    const page = JSON.parse(textOf(await callTool(ctx(), "bases_query", { base: "Tasks.base", offset: 450, limit: 100 })));
    const app = await appBases.queryBase(appDeps(), "Tasks.base", undefined, { offset: 450, limit: 100 });
    expect(page.rows).toEqual(JSON.parse(JSON.stringify(app.rows)));
    expect(page.rows).toHaveLength(50);
  });

  it("the CLI prints a tab-separated table by default", async () => {
    put("Tasks/a.md", task("doing", 3));
    const r = await cli(["bases", "query", "Tasks.base"]);
    expect(r.out[0]!.split("\t")[0]).toBe("path");
    expect(r.out[1]!.startsWith("Tasks/a.md\t")).toBe(true);
    expect(r.err.at(-1)).toContain('1 of 1 row(s), view "Open"');
  });
});

describe("bases_update goes through the approval queue", () => {
  beforeEach(async () => {
    put("Tasks/a.md", task("todo", 1));
    put("Tasks/b.md", task("todo", 2));
    put("Tasks/c.md", task("done", 3));
    await enableClient(vault, "claude-code", ["search", "read", "propose"]);
  });
  const edits = [
    { path: "Tasks/a.md", set: { status: "doing" } },
    { path: "Tasks/b.md", set: { status: "doing", priority: 5 } },
    { path: "Tasks/c.md", set: { status: "done" } }, // already so
  ];

  it("proposes one change per changed note in one batch, and writes nothing", async () => {
    const before = snapshot();
    const r = await callTool(ctx(), "bases_update", { edits });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("2 note(s)");
    expect(snapshot()).toEqual(before);
    const pending = await listPending(vault);
    expect(pending.map((p) => p.path).sort()).toEqual(["Tasks/a.md", "Tasks/b.md"]);
    expect(pending.every((p) => p.tool === "bases_update" && p.client === "claude-code")).toBe(true);
    const batch = await readBatch(vault, r.batchId!);
    expect(batch!.ids.sort()).toEqual(pending.map((p) => p.id).sort());
    // The proposed text is what the app's engine computes.
    const app = new Map(files);
    await appBases.updateRows({ ...appDeps(), paths: async () => [...app.keys()], readText: async (p) => app.get(p)!, write: async (p, t) => void app.set(p, t), confirm: async () => true }, edits);
    for (const p of pending) expect(p.after).toBe(app.get(p.path));
  });

  it("a rejected update writes nothing; an approved one writes exactly the proposals", async () => {
    const before = snapshot();
    await callTool(ctx(), "bases_update", { edits });
    for (const p of await listPending(vault)) await rejectPending(vault, p.id, "app");
    expect(snapshot()).toEqual(before);
    await callTool(ctx(), "bases_update", { edits });
    for (const p of await listPending(vault)) expect((await approvePending(vault, p.id, "app")).status).toBe("applied");
    expect(read("Tasks/a.md")).toContain("status: doing");
    expect(read("Tasks/b.md")).toContain("priority: 5");
    expect(read("Tasks/c.md")).toBe(files.get("Tasks/c.md"));
  });

  it("invalid edits are refused before anything is queued", async () => {
    for (const bad of [[{ path: "../x.md", set: { a: 1 } }], [{ path: "Tasks/a.md", set: {} }], "nope", [{ path: "Tasks/a.md", set: { "bad name!": 1 } }]]) {
      expect((await callTool(ctx(), "bases_update", { edits: bad })).isError).toBe(true);
    }
    expect(await listPending(vault)).toEqual([]);
  });

  it("over MCP 2026-07-28: input_required while waiting; after a rejection the retry reports it and nothing is written", async () => {
    const ep = new McpEndpoint({ vault });
    const meta = { [META.protocolVersion]: "2026-07-28", [META.clientInfo]: { name: "claude-code", version: "1" }, [META.clientCapabilities]: {} };
    const call = { name: "bases_update", arguments: { edits } };
    const first = await ep.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { ...call, _meta: meta } });
    const r1 = (first as unknown as { result: { resultType: string; requestState: string } }).result;
    expect(r1.resultType).toBe("input_required");
    const before = snapshot();
    const [p1, p2] = await listPending(vault);
    await rejectPending(vault, p1!.id, "app");
    const mid = await ep.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { ...call, requestState: r1.requestState, _meta: meta } });
    expect((mid as unknown as { result: { resultType: string } }).result.resultType).toBe("input_required"); // one still waits
    await rejectPending(vault, p2!.id, "app");
    const done = (await ep.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { ...call, requestState: r1.requestState, _meta: meta } })) as unknown as {
      result: { resultType: string; isError?: boolean; content: { text: string }[] };
    };
    expect(done.result.resultType).toBe("complete");
    expect(done.result.isError).toBe(true);
    expect(done.result.content[0]!.text).toContain("0 note(s) written, 2 rejected");
    expect(snapshot()).toEqual(before);
  });
});

describe("lumen bases update", () => {
  beforeEach(() => {
    put("Tasks/a.md", task("todo", 1));
    put("Tasks/b.md", task("todo", 2));
    writeFileSync(path.join(vault, "..", `${path.basename(vault)}-edits.json`), JSON.stringify([{ path: "Tasks/a.md", set: { status: "doing" } }, { path: "Tasks/b.md", set: { status: "doing" } }]));
  });
  const editsFile = () => path.join(vault, "..", `${path.basename(vault)}-edits.json`);
  afterEach(() => rmSync(editsFile(), { force: true }));

  it("--dry-run shows the change and writes and queues nothing", async () => {
    const before = snapshot();
    const r = await cli(["bases", "update", "--edits", editsFile(), "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("2 note(s) would change (status)");
    expect(r.out.some((l) => l === "+ status: doing")).toBe(true);
    expect(r.out.at(-1)).toContain("Dry run");
    expect(snapshot()).toEqual(before);
    expect(await listPending(vault)).toEqual([]);
  });

  it("without --approve it only queues; rejecting the batch writes nothing", async () => {
    const before = snapshot();
    const r = await cli(["bases", "update", "--edits", editsFile()]);
    expect(r.out.at(-1)).toContain("Queued as batch");
    expect(snapshot()).toEqual(before);
    expect((await cli(["mcp", "reject", "--all"])).code).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("--approve without a TTY (an agent's shell) writes nothing; at a terminal it shows each diff and writes what you confirm", async () => {
    const before = snapshot();
    expect((await cli(["bases", "update", "--edits", editsFile(), "--approve"])).code).toBe(1);
    expect(snapshot()).toEqual(before);
    expect((await cli(["mcp", "reject", "--all"])).code).toBe(0);
    const no = await cli(["bases", "update", "--edits", editsFile(), "--approve"], { tty: true, answer: "no" });
    expect(no.out.at(-1)).toBe("wrote 0 note(s)");
    expect(snapshot()).toEqual(before);
    expect((await cli(["mcp", "reject", "--all"])).code).toBe(0);
    const r = await cli(["bases", "update", "--edits", editsFile(), "--approve"], { tty: true, answer: "yes" });
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l === "+ status: doing")).toBe(true);
    expect(r.out.at(-1)).toBe("wrote 2 note(s)");
    expect(read("Tasks/a.md")).toContain("status: doing");
    expect(await listPending(vault)).toEqual([]);
  });
});

describe("0 writes without approval (40 attempts)", () => {
  it("leaves the vault byte-identical", async () => {
    for (let i = 0; i < 20; i++) put(`Tasks/t${i}.md`, task("todo", i));
    await enableClient(vault, "claude-code", ["search", "read", "propose"]);
    await enableClient(vault, "reader", ["search", "read"]);
    const before = snapshot();
    const ep = new McpEndpoint({ vault });
    for (let i = 0; i < 40; i++) {
      const e = [{ path: `Tasks/t${i % 20}.md`, set: { status: `s${i}` } }];
      switch (i % 4) {
        case 0:
          await callTool(ctx(), "bases_update", { edits: e });
          break;
        case 1:
          expect((await callTool(ctx("reader"), "bases_update", { edits: e })).isError).toBe(true);
          break;
        case 2:
          await ep.handle({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "bases_update", arguments: { edits: e }, _meta: { [META.protocolVersion]: "2026-07-28", [META.clientInfo]: { name: "claude-code", version: "1" }, [META.clientCapabilities]: { elicitation: {} } } } });
          break;
        default:
          expect((await cli(["bases", "update", "--edits", path.join(vault, "missing.json")])).code).toBe(1);
      }
    }
    expect(snapshot()).toEqual(before);
    expect(existsSync(path.join(vault, ".lumen/mcp/pending"))).toBe(true);
  });
});
