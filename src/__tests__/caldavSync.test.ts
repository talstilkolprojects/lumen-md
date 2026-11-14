/**
 * CalDAV task sync (plan W7.20): the planner, the line edits, and the whole
 * loop against a CalDAV server: the in-memory fake by default, a real one
 * (Radicale) when LUMEN_CALDAV_URL names an empty-able collection, e.g.
 * LUMEN_CALDAV_URL=http://127.0.0.1:5232/lumen/tasks/.
 */
import { describe, expect, it } from "vitest";
import { basicAuth, createCalDavClient, parseMultistatus, type CalDavClient } from "../calendar/caldav";
import { todoToIcs, type Todo } from "../calendar/ical";
import { applyLocal, emptyState, hashTodo, localTasksOf, planSync, remoteTasksOf, resolveConflict, runSync, taskLine, type Choice, type SyncState, type VaultIO } from "../calendar/taskSync";
import { fakeCalDav } from "./helpers/fakeServers/caldav";

const env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const REAL = env.LUMEN_CALDAV_URL;

function memVault(files: Record<string, string> = {}): VaultIO & { files: Map<string, string> } {
  const m = new Map(Object.entries(files));
  return { files: m, list: async () => [...m.keys()], read: async (p) => m.get(p) ?? null, write: async (p, c) => void m.set(p, c) };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function server(name: string): Promise<{ client: CalDavClient; raw: CalDavClient; requests?: Array<{ authorization: string | null }> }> {
  if (REAL) {
    const url = new URL(`${name}/`, REAL).href;
    const client = createCalDavClient({ collection: url, fetch: globalThis.fetch.bind(globalThis) });
    await client.makeCalendar(name);
    for (const r of await client.list()) await client.remove(r.href, r.etag);
    return { client, raw: client };
  }
  const auth = basicAuth("dana", "s3cret-app-pass");
  const f = fakeCalDav({ collection: `https://dav.example/cal/${name}/`, authorization: auth });
  const client = createCalDavClient({ collection: `https://dav.example/cal/${name}/`, fetch: f.fetch, authorization: auth });
  return { client, raw: client, requests: f.requests };
}

const todo = (summary: string, over: Partial<Todo> = {}): Todo => ({ uid: over.uid ?? summary, summary, due: "2026-11-20", start: null, completed: false, completedOn: null, ...over });

describe("CalDAV task sync (W7.20)", () => {
  it("dated tasks and tasks with an id sync; a copied line's id goes to the first one only", () => {
    const note = [
      "# Day",
      "- [ ] buy milk 📅 2026-11-20",
      "- [ ] no date",
      "- [x] call Dana ⏳ 2026-11-19 ✅ 2026-11-18 <!-- lumen-caldav:u1 -->",
      "- [ ] copied <!-- lumen-caldav:u1 -->",
      "- [-] cancelled 📅 2026-11-20",
      "```",
      "- [ ] in code 📅 2026-11-20",
      "```",
    ].join("\n");
    const t = localTasksOf("d.md", note);
    expect(t.map((x) => [x.uid, x.line, x.todo.summary, x.todo.due, x.todo.completed])).toEqual([
      [null, 1, "buy milk", "2026-11-20", false],
      ["u1", 3, "call Dana", "2026-11-19", true],
    ]);
  });

  it("three-way: one side changed wins, both changed is a conflict, a delete against an edit is a conflict", () => {
    const st: SyncState = { v: 1, entries: {} };
    const base = (t: Todo) => (st.entries[t.uid] = { href: `h/${t.uid}`, etag: "e1", hash: hashTodo(t) });
    const loc = (t: Todo) => ({ uid: t.uid, path: "a.md", line: 0, todo: t });
    const rem = (t: Todo, etag = "e1") => ({ uid: t.uid, href: `h/${t.uid}`, etag, todo: t });
    const a = todo("a"), b = todo("b"), c = todo("c"), d = todo("d"), e = todo("e"), f = todo("f");
    [a, b, c, d, e, f].forEach(base);
    const plan = planSync(
      [loc({ ...a, completed: true }), loc(b), loc({ ...c, summary: "c here" }), loc({ ...e, summary: "e edited" }), loc(f)],
      [rem(a), rem({ ...b, due: "2026-12-01" }, "e2"), rem({ ...c, summary: "c there" }, "e2"), rem({ ...d, summary: "d there" }, "e2"), rem(f, "e9")],
      st,
    );
    expect(plan.map((x) => `${x.kind}:${"uid" in x ? x.uid : ""}${x.kind === "conflict" ? ":" + x.why : ""}`)).toEqual([
      "push-update:a",
      "pull-update:b",
      "conflict:c:both-changed",
      "conflict:d:deleted-here-changed-there",
      "conflict:e:changed-here-deleted-there",
      "agree:f",
    ]);
    const conflict = plan[2] as Extract<(typeof plan)[number], { kind: "conflict" }>;
    expect(resolveConflict(conflict, "here").map((x) => x.kind)).toEqual(["push-update"]);
    expect(resolveConflict(conflict, "there").map((x) => x.kind)).toEqual(["pull-update"]);
    expect(resolveConflict(conflict, "both").map((x) => x.kind)).toEqual(["push-create", "pull-create"]);
  });

  it("line edits find tasks by id, keep the note's other fields, and keep CRLF", () => {
    const note = "# x\r\n- [ ] old 🔼 #work 📅 2026-11-20 <!-- lumen-caldav:u1 -->\r\n- [ ] other\r\n";
    const line = taskLine({ summary: "new #work", due: "2026-11-21", start: null, completed: true, completedOn: "2026-11-15" }, "u1", note.split("\r\n")[1]);
    expect(line).toBe("- [x] new #work 🔼 📅 2026-11-21 ✅ 2026-11-15 <!-- lumen-caldav:u1 -->");
    const out = applyLocal(note, [{ path: "n", uid: "u1", op: "set", line }, { path: "n", uid: "u2", op: "append", line: "- [ ] from server <!-- lumen-caldav:u2 -->" }]);
    expect(out).toBe("# x\r\n" + line + "\r\n- [ ] other\r\n- [ ] from server <!-- lumen-caldav:u2 -->\r\n");
    expect(applyLocal(out, [{ path: "n", uid: "u1", op: "delete" }])).toBe("# x\r\n- [ ] other\r\n- [ ] from server <!-- lumen-caldav:u2 -->\r\n");
    // A scheduled-only task stays scheduled when the server changes its date.
    expect(taskLine({ summary: "s", due: "2026-12-02", start: null, completed: false, completedOn: null }, "u3", "- [ ] s ⏳ 2026-12-01 <!-- lumen-caldav:u3 -->")).toBe("- [ ] s ⏳ 2026-12-02 <!-- lumen-caldav:u3 -->");
  });

  it("multistatus with any prefixes and escaped calendar data", () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/c/a%20b.ics</D:href><D:propstat><D:prop><D:getetag>"9"</D:getetag><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR&#13;
SUMMARY:a &amp; b</C:calendar-data></D:prop></D:propstat></D:response><D:response><D:href>/c/</D:href></D:response></D:multistatus>`;
    expect(parseMultistatus(xml, "https://s.example/c/")).toEqual([{ href: "https://s.example/c/a%20b.ics", etag: '"9"', ics: "BEGIN:VCALENDAR\r\nSUMMARY:a & b" }]);
  });

  it(`create, done and delete go both ways in one sync each (${REAL ? "Radicale" : "fake server"}), well under 30 s`, async () => {
    const { client, raw } = await server("e2e");
    const vault = memVault({ "Daily/2026-11-14.md": "# 14.11\n- [ ] write report 📅 2026-11-20\n" });
    let state = emptyState();
    let n = 0;
    const sync = async () => {
      const t0 = Date.now();
      const r = await runSync({ vault, client, state, inbox: "Tasks/Calendar.md", newUid: () => `lumen-${++n}`, now: () => new Date("2026-11-14T10:00:00Z") });
      state = r.state;
      expect(r.errors).toEqual([]);
      return Date.now() - t0;
    };
    const times: number[] = [];
    // Here → there: create, done, delete.
    times.push(await sync());
    let remote = remoteTasksOf(await raw.list());
    expect(remote.map((r) => [r.todo.summary, r.todo.completed])).toEqual([["write report", false]]);
    expect(vault.files.get("Daily/2026-11-14.md")).toContain("<!-- lumen-caldav:lumen-1 -->");
    vault.files.set("Daily/2026-11-14.md", vault.files.get("Daily/2026-11-14.md")!.replace("- [ ]", "- [x]"));
    times.push(await sync());
    expect(remoteTasksOf(await raw.list())[0].todo.completed).toBe(true);
    vault.files.set("Daily/2026-11-14.md", "# 14.11\n");
    times.push(await sync());
    expect(await raw.list()).toEqual([]);
    // There → here.
    await raw.create("phone.ics", todoToIcs(todo("call the bank", { uid: "phone-1" }), new Date()));
    times.push(await sync());
    expect(vault.files.get("Tasks/Calendar.md")).toBe("- [ ] call the bank 📅 2026-11-20 <!-- lumen-caldav:phone-1 -->\n");
    remote = remoteTasksOf(await raw.list());
    await raw.update(remote[0].href, todoToIcs(todo("call the bank", { uid: "phone-1", completed: true, completedOn: "2026-11-14" }), new Date()), remote[0].etag);
    times.push(await sync());
    expect(vault.files.get("Tasks/Calendar.md")).toBe("- [x] call the bank 📅 2026-11-20 ✅ 2026-11-14 <!-- lumen-caldav:phone-1 -->\n");
    remote = remoteTasksOf(await raw.list());
    await raw.remove(remote[0].href, remote[0].etag);
    times.push(await sync());
    expect(vault.files.get("Tasks/Calendar.md")).toBe("");
    // A sync with nothing new changes nothing.
    const before = JSON.stringify([...vault.files]);
    await sync();
    expect(JSON.stringify([...vault.files])).toBe(before);
    expect(Math.max(...times)).toBeLessThan(30_000);
    console.log(`CALDAV e2e (${REAL ? "Radicale" : "fake"}): sync times ms ${times.join(", ")}`);
  }, 120_000);

  it(`200 random changes on both sides (${REAL ? "Radicale" : "fake server"}): no task lost, none duplicated`, async () => {
    const r = rng(Number(env.LUMEN_CALDAV_SEED ?? 2026));
    const { client, raw, requests } = await server("fuzz");
    const notes = ["A.md", "B.md", "Daily/2026-11-14.md"];
    const vault = memVault(Object.fromEntries(notes.map((p) => [p, `# ${p}\n`])));
    let state = emptyState();
    let label = 0;
    let uid = 0;
    const deleted = new Set<string>();
    const both = new Map<string, number>();
    const labelOf = (s: string) => /T\d+/.exec(s)?.[0] ?? "?";
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    let conflicts = 0;
    const sync = async () => {
      const rep = await runSync({
        vault, client, state, inbox: "Tasks/Calendar.md", newUid: () => `u${++uid}`, now: () => new Date(),
        decide: async (c) => {
          conflicts++;
          const choice: Choice = pick(["here", "there", "both"] as const);
          const l = labelOf(c.local?.todo.summary ?? c.remote?.todo.summary ?? "");
          if (choice === "both" && c.local && c.remote) both.set(l, (both.get(l) ?? 0) + 1);
          return choice;
        },
      });
      expect(rep.errors).toEqual([]);
      state = rep.state;
    };
    const localLines = () => [...vault.files].flatMap(([p, c]) => c.split("\n").map((l, i) => ({ p, i, l }))).filter((x) => /^- \[.\] T\d+/.test(x.l));
    for (let op = 0; op < 200; op++) {
      const k = r();
      if (k < 0.5) {
        const lines = localLines();
        const kind = lines.length ? r() : 0;
        if (kind < 0.35) {
          const p = pick(notes);
          vault.files.set(p, vault.files.get(p)! + `- [ ] T${++label} task 📅 2026-11-${String(15 + Math.floor(r() * 10)).padStart(2, "0")}\n`);
        } else {
          const x = pick(lines);
          const ls = vault.files.get(x.p)!.split("\n");
          if (kind < 0.6) ls[x.i] = ls[x.i].startsWith("- [ ]") ? ls[x.i].replace("- [ ]", "- [x]") : ls[x.i].replace("- [x]", "- [ ]");
          else if (kind < 0.85) ls[x.i] = ls[x.i].replace(/(T\d+) \S+/, `$1 v${op}`);
          else {
            deleted.add(labelOf(ls[x.i]));
            ls.splice(x.i, 1);
          }
          vault.files.set(x.p, ls.join("\n"));
        }
      } else {
        const items = remoteTasksOf(await raw.list());
        const kind = items.length ? r() : 0;
        if (kind < 0.35) await raw.create(`srv-${op}.ics`, todoToIcs(todo(`T${++label} server`, { uid: `srv-${op}` }), new Date()));
        else {
          const it = pick(items);
          const t = { uid: it.uid, ...it.todo };
          if (kind < 0.6) await raw.update(it.href, todoToIcs({ ...t, completed: !t.completed, completedOn: t.completed ? null : "2026-11-14" }, new Date()), it.etag);
          else if (kind < 0.85) await raw.update(it.href, todoToIcs({ ...t, summary: t.summary.replace(/(T\d+) \S+/, `$1 s${op}`) }, new Date()), it.etag);
          else {
            deleted.add(labelOf(t.summary));
            await raw.remove(it.href, it.etag);
          }
        }
      }
      if (r() < 0.3) await sync();
    }
    for (let i = 0; i < 3; i++) await sync();
    // Converged: the same tasks on both sides, each once (or once more per "keep both").
    const local = [...vault.files].flatMap(([p, c]) => localTasksOf(p, c));
    const remote = remoteTasksOf(await raw.list());
    expect(local.every((t) => t.uid)).toBe(true);
    expect(new Set(local.map((t) => t.uid)).size).toBe(local.length);
    expect(new Set(remote.map((t) => t.uid)).size).toBe(remote.length);
    expect([...local.map((t) => t.uid)].sort()).toEqual([...remote.map((t) => t.uid)].sort());
    const R = new Map(remote.map((t) => [t.uid, t]));
    for (const t of local) expect(hashTodo(t.todo), t.todo.summary).toBe(hashTodo(R.get(t.uid!)!.todo));
    const count = new Map<string, number>();
    for (const t of local) count.set(labelOf(t.todo.summary), (count.get(labelOf(t.todo.summary)) ?? 0) + 1);
    const lost = Array.from({ length: label }, (_, i) => `T${i + 1}`).filter((l) => !deleted.has(l) && !count.has(l));
    const dup = [...count].filter(([l, n]) => n > 1 + (both.get(l) ?? 0)).map(([l]) => l);
    console.log(`CALDAV fuzz (${REAL ? "Radicale" : "fake"}): 200 changes, ${label} tasks made, ${deleted.size} deleted, ${local.length} at the end, ${conflicts} conflicts, lost ${lost.length}, duplicated ${dup.length}`);
    expect(lost).toEqual([]);
    expect(dup).toEqual([]);
    // The password only ever travels in the Authorization header.
    if (requests) expect(requests.every((q) => q.authorization === basicAuth("dana", "s3cret-app-pass"))).toBe(true);
  }, 600_000);
});
