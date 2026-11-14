/**
 * `lumen` — the vault on disk from a terminal (plan W2.3).
 *
 *   lumen search <words…> [--limit n] [--json]
 *   lumen open <note> [--print]        open in the default app, or print it
 *   lumen new <path> [text…]           create a note (fails if it exists)
 *   lumen append <path> <text…>        add text to the end of a note
 *   lumen daily [text…] [--folder d]   today's note (journal/YYYY-MM-DD.md);
 *                                      with text, adds "- HH:MM text"
 *   lumen bases query <f.base> [--view v] [--json]   a view's rows (W8.1)
 *   lumen bases update --edits e.json [--dry-run] [--approve]
 *                                      property edits into the approval queue
 *   lumen mcp status                   which MCP clients may do what
 *   lumen mcp enable <client> [--scopes search,read,propose]
 *   lumen mcp disable <client>
 *   lumen mcp review                   proposals from MCP clients, as diffs
 *   lumen mcp approve <id>|--all       write them
 *   lumen mcp reject <id>|--all        drop them
 *   lumen mcp log [--limit n]          the ledger
 *   lumen mcp serve [--client id]      the MCP server on stdio
 *
 * The vault is `--vault <dir>`, else $LUMEN_VAULT, else the current folder.
 * `new`, `append` and `daily` are you at your terminal, so they write
 * directly (and are logged as client `cli`); changes from MCP clients wait
 * in the approval queue.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ALL_SCOPES, DEFAULT_SCOPES, disableClient, enableClient, parseScopes, readConfig, writeFileAtomic } from "./vault/config.js";
import { appendLedger, readLedger } from "./vault/ledger.js";
import { approvePending, lineDiff, listPending, readNote, rejectPending } from "./vault/pending.js";
import { absPath, notePath } from "./vault/paths.js";
import { VaultIndex } from "./vault/search.js";
import { planBasesUpdate, proposeBatch, queryVaultBase, relForCli } from "./vault/bases.js";

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  now?: () => Date;
  /** Opens a file in the system's default app (tests pass a fake). */
  openFile?: (abs: string) => void;
}

export const VAULT_COMMANDS = ["search", "open", "new", "append", "daily", "bases", "mcp"] as const;

export const USAGE = [
  "usage: lumen search <words…> [--limit n] [--json]",
  "       lumen open <note> [--print]",
  "       lumen new <path> [text…]",
  "       lumen append <path> <text…>",
  "       lumen daily [text…] [--folder journal]",
  "       lumen bases query <file.base> [--view name] [--offset n] [--limit n] [--json]",
  "       lumen bases update --edits <edits.json> [--dry-run] [--approve]",
  "       lumen mcp status | enable <client> [--scopes search,read,propose] | disable <client>",
  "       lumen mcp review | approve <id>|--all | reject <id>|--all | log [--limit n] | serve [--client id]",
  "       (vault: --vault <dir>, $LUMEN_VAULT, or the current folder)",
].join("\n");

const BOOLEAN_FLAGS = new Set(["json", "print", "all", "dry-run", "approve"]);

export function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(args[i]);
    if (!m) positional.push(args[i]);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (BOOLEAN_FLAGS.has(m[1])) flags[m[1]] = "1";
    else flags[m[1]] = args[++i] ?? "";
  }
  return { flags, positional };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function defaultOpen(abs: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [abs]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", abs]] : ["xdg-open", [abs]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** A note named by path, or else by title / file name (case-insensitive). */
async function resolveNote(vault: string, name: string): Promise<string | null> {
  try {
    const rel = notePath(name);
    if (await exists(absPath(vault, rel))) return rel;
  } catch {
    /* not a usable path: look it up by name */
  }
  const index = new VaultIndex(vault);
  await index.refresh();
  const want = name.toLowerCase().replace(/\.md$/, "");
  const byName = index.paths().find((p) => p.split("/").pop()!.replace(/\.(md|markdown|txt)$/i, "").toLowerCase() === want);
  if (byName) return byName;
  return (await index.search(name, 1))[0]?.path ?? null;
}

async function writeDirect(vault: string, tool: string, rel: string, text: string): Promise<void> {
  await writeFileAtomic(absPath(vault, rel), text);
  await appendLedger(vault, { client: "cli", tool, path: rel, decision: "written", bytesOut: 0 });
}

function appendText(before: string | null, add: string): string {
  if (before === null || before === "") return add.endsWith("\n") ? add : `${add}\n`;
  const sep = before.endsWith("\n") ? "" : "\n";
  return `${before}${sep}${add}${add.endsWith("\n") ? "" : "\n"}`;
}

export async function runVaultCli(argv: string[], io: CliIO): Promise<number> {
  try {
    return await runCommand(argv, io);
  } catch (e) {
    io.err(`error: ${(e as Error)?.message ?? String(e)}`);
    return 1;
  }
}

async function runCommand(argv: string[], io: CliIO): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  const vault = path.resolve(io.cwd, flags.vault || io.env.LUMEN_VAULT || ".");
  const now = io.now ?? (() => new Date());

  switch (cmd) {
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) break;
      const index = new VaultIndex(vault);
      const t0 = Date.now();
      const hits = await index.search(query, Number(flags.limit) || 20);
      if (flags.json) io.out(JSON.stringify(hits));
      else {
        for (const h of hits) io.out(`${h.path}\t${h.title}\t${h.snippet}`);
        io.err(`${hits.length} note(s), ${index.size} indexed, ${Date.now() - t0} ms`);
      }
      return hits.length ? 0 : 3;
    }
    case "open": {
      if (!rest.length) break;
      const rel = await resolveNote(vault, rest.join(" "));
      if (!rel) {
        io.err(`No note matches '${rest.join(" ")}'.`);
        return 3;
      }
      if (flags.print) io.out((await readNote(vault, rel)) ?? "");
      else {
        (io.openFile ?? defaultOpen)(absPath(vault, rel));
        io.out(rel);
      }
      return 0;
    }
    case "new": {
      if (!rest.length) break;
      const rel = notePath(rest[0]);
      if ((await readNote(vault, rel)) !== null) {
        io.err(`${rel} already exists.`);
        return 1;
      }
      const body = rest.slice(1).join(" ");
      const title = path.posix.basename(rel).replace(/\.(md|markdown|txt)$/i, "");
      await writeDirect(vault, "new", rel, body ? appendText(null, body) : `# ${title}\n`);
      io.out(rel);
      return 0;
    }
    case "append": {
      if (rest.length < 2) break;
      const rel = notePath(rest[0]);
      await writeDirect(vault, "append", rel, appendText(await readNote(vault, rel), rest.slice(1).join(" ")));
      io.out(rel);
      return 0;
    }
    case "daily": {
      const d = now();
      const folder = (flags.folder || "journal").replace(/^\/+|\/+$/g, "");
      const rel = notePath(`${folder ? `${folder}/` : ""}${dayStamp(d)}.md`);
      const before = await readNote(vault, rel);
      const add = rest.join(" ").trim();
      if (add) await writeDirect(vault, "daily", rel, appendText(before ?? `# ${dayStamp(d)}\n`, `- ${pad2(d.getHours())}:${pad2(d.getMinutes())} ${add}`));
      else if (before === null) await writeDirect(vault, "daily", rel, `# ${dayStamp(d)}\n`);
      io.out(rel);
      return 0;
    }
    case "bases":
      return runBases(vault, rest, flags, io);
    case "mcp":
      return runMcp(vault, rest, flags, io);
  }
  io.err(USAGE);
  return 1;
}

/**
 * `lumen bases` (plan W8.1): the app's Bases engine from a terminal.
 * `query` prints a view's rows (tab-separated, or JSON). `update` takes the
 * same edits as `lumen.bases.update` / the `bases_update` MCP tool and
 * queues them in the approval queue — `--dry-run` only shows what would
 * change, `--approve` approves the batch right away (you are the user).
 */
async function runBases(vault: string, rest: string[], flags: Record<string, string>, io: CliIO): Promise<number> {
  const [sub, arg] = rest;
  if (sub === "query" && arg) {
    const r = await queryVaultBase(vault, relForCli(vault, arg), flags.view, { offset: flags.offset, limit: flags.limit });
    if (flags.json) io.out(JSON.stringify(r));
    else {
      io.out(["path", ...r.columns.map((c) => c.label)].join("\t"));
      for (const row of r.rows) io.out([row.path, ...r.columns.map((c) => cellText(row.cells[c.id]))].join("\t"));
    }
    for (const e of r.errors) io.err(`warning: ${e}`);
    io.err(`${r.rows.length} of ${r.total} row(s), view "${r.view}"`);
    return 0;
  }
  if (sub === "update" && flags.edits) {
    const raw = flags.edits === "-" ? await readStdin() : await fs.readFile(path.resolve(io.cwd, flags.edits), "utf8");
    let edits: unknown;
    try {
      edits = JSON.parse(raw);
    } catch {
      io.err("error: --edits must be a JSON list of { path, set }");
      return 1;
    }
    const plan = await planBasesUpdate(vault, edits);
    const s = plan.summary;
    io.out(`${plan.changes.length} note(s) would change (${s.properties.join(", ") || "no properties"}); ${s.unchanged} row(s) already have these values.`);
    for (const c of plan.changes.slice(0, 20)) {
      io.out(`── ${c.path}`);
      for (const l of lineDiff(c.before, c.after, 12)) io.out(l);
    }
    if (plan.changes.length > 20) io.out(`… and ${plan.changes.length - 20} more`);
    if (flags["dry-run"] || !plan.changes.length) {
      if (flags["dry-run"]) io.out("Dry run: nothing written, nothing queued.");
      return 0;
    }
    const batch = await proposeBatch(vault, "cli", "bases_update", plan.changes);
    if (!flags.approve) {
      io.out(`Queued as batch ${batch.id}: review with \`lumen mcp review\`, then \`lumen mcp approve --all\` (or in Lumen's review screen).`);
      return 0;
    }
    let failed = 0;
    for (const id of batch.ids) {
      const r = await approvePending(vault, id, "cli");
      if (r.status !== "applied") {
        failed++;
        io.err(r.status === "missing" ? `no proposal ${id}` : `not written: ${r.reason} (${r.pending.path})`);
      }
    }
    io.out(`wrote ${batch.ids.length - failed} note(s)`);
    return failed ? 1 : 0;
  }
  io.err(USAGE);
  return 1;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cellText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/[\t\n]+/g, " ");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function runMcp(vault: string, rest: string[], flags: Record<string, string>, io: CliIO): Promise<number> {
  const [sub, arg] = rest;
  switch (sub) {
    case "status": {
      const cfg = await readConfig(vault);
      const ids = Object.keys(cfg.clients).sort();
      if (!ids.length) io.out("MCP access is off: no client is enabled. Turn one on with `lumen mcp enable <client> --scopes search,read`.");
      for (const id of ids) {
        const g = cfg.clients[id];
        io.out(`${id}\t${g.enabled ? "on" : "off"}\t${g.scopes.join(",") || "-"}\t${g.since}`);
      }
      io.out(`${(await listPending(vault)).length} proposal(s) waiting — lumen mcp review`);
      return 0;
    }
    case "enable": {
      if (!arg) break;
      const scopes = flags.scopes ? parseScopes(flags.scopes) : [...DEFAULT_SCOPES];
      const g = await enableClient(vault, arg, scopes);
      io.out(`enabled ${arg}: ${g.scopes.join(", ") || "(no scopes)"}${g.scopes.includes("propose") ? " — its changes wait for your approval" : ""}`);
      return 0;
    }
    case "disable": {
      if (!arg) break;
      io.out((await disableClient(vault, arg)) ? `disabled ${arg}` : `${arg} was not enabled`);
      return 0;
    }
    case "review": {
      const list = await listPending(vault);
      if (!list.length) io.out("No proposals waiting.");
      for (const p of list) {
        io.out(`── ${p.id}  ${p.client} · ${p.tool} · ${p.path}${p.before === null ? " (new)" : ""} · ${p.createdAt}`);
        for (const l of lineDiff(p.before, p.after)) io.out(l);
      }
      return 0;
    }
    case "approve":
    case "reject": {
      const ids = flags.all ? (await listPending(vault)).map((p) => p.id) : arg ? [arg] : [];
      if (!ids.length) {
        if (flags.all) {
          io.out("No proposals waiting.");
          return 0;
        }
        break;
      }
      let failed = 0;
      for (const id of ids) {
        if (sub === "reject") {
          const p = await rejectPending(vault, id);
          if (p) io.out(`rejected ${id} (${p.path})`);
          else {
            failed++;
            io.err(`no proposal ${id}`);
          }
          continue;
        }
        const r = await approvePending(vault, id);
        if (r.status === "applied") io.out(`wrote ${r.pending.path} (${id})`);
        else {
          failed++;
          io.err(r.status === "missing" ? `no proposal ${id}` : `not written: ${r.reason} (${id}, ${r.pending.path})`);
        }
      }
      return failed ? 1 : 0;
    }
    case "log": {
      for (const e of await readLedger(vault, Number(flags.limit) || 50)) {
        io.out(`${e.ts}\t${e.client}\t${e.tool}\t${e.decision}\t${e.path ?? ""}\t${e.bytesOut}B${e.reason ? `\t${e.reason}` : ""}`);
      }
      return 0;
    }
    case "serve": {
      // Not a static import: the stdio loop is only needed by `serve`.
      const spec = "./server.js";
      const mod = (await import(spec)) as { serveStdio: (vault: string, client?: string) => Promise<void> };
      await mod.serveStdio(vault, flags.client || io.env.LUMEN_MCP_CLIENT);
      return -1;
    }
  }
  io.err(`usage: lumen mcp status | enable <client> [--scopes ${ALL_SCOPES.join(",")}] | disable <client> | review | approve <id>|--all | reject <id>|--all | log | serve`);
  return 1;
}
