/**
 * Bulk property editing (plan W7.4): each operation on one note, the
 * selection model, and 1,000 notes edited and undone in one step with only
 * their frontmatter changed.
 */
import { describe, it, expect } from "vitest";
import { applyBulkOp, applyBulkOpYaml, bodyOf, planBulkEdit, selectRows, wouldChange, type BulkOp } from "../views/bulkEdit";
import { lastBulkEditAt, runBulkEdit, undoBulkChanges, undoLastBulkEdit, __resetBulkUndo } from "../views/bulkEditRun";
import { createMemoryBackend, setVaultBackend } from "../storage/vault";
import { readWorkspaceFile, readWorkspaceTexts, writeWorkspaceFile, writeWorkspaceFileIf } from "../storage/workspace";
import { parseProperties } from "../properties/frontmatter";
import { fastBulkOp } from "../views/bulkFast";

const NOTE = "---\ntitle: א\nstatus: todo   # where it is\ntags: [a, b]\nשפה: עברית\n---\n# Body\n\nstatus: todo appears here too. tags: [a]\n";

const prop = (text: string, key: string) => parseProperties(text).properties.find((p) => p.key === key)?.value;

describe("one operation, one note", () => {
  it("sets a value in place and keeps the comment, the body and the other lines", () => {
    const r = applyBulkOp(NOTE, { kind: "set", key: "status", value: "done" });
    expect(r.skip).toBeUndefined();
    expect(r.text).toBe(NOTE.replace("status: todo   #", "status: done   #"));
    expect(bodyOf(r.text)).toBe(bodyOf(NOTE));
  });
  it("sets a Hebrew field and a Hebrew date, and adds a missing field", () => {
    const he = applyBulkOp(NOTE, { kind: "set", key: "שפה", value: "יידיש" }).text;
    expect(prop(he, "שפה")).toBe("יידיש");
    const date = applyBulkOp(NOTE, { kind: "set", key: "תאריך עברי", value: "י״ד בחשוון תשפ״ז" }).text;
    expect(prop(date, "תאריך עברי")).toBe("י״ד בחשוון תשפ״ז");
    expect(bodyOf(date)).toBe(bodyOf(NOTE));
    const none = applyBulkOp("Just a body\n", { kind: "set", key: "due", value: "2026-11-14" }).text;
    expect(none.endsWith("Just a body\n")).toBe(true);
    expect(prop(none, "due")).toBe("2026-11-14");
  });
  it("adds and removes a tag, case and # aside, without duplicates", () => {
    const add = applyBulkOp(NOTE, { kind: "addTag", key: "tags", tag: "#פרויקט" }).text;
    expect(prop(add, "tags")).toEqual(["a", "b", "פרויקט"]);
    expect(applyBulkOp(add, { kind: "addTag", key: "tags", tag: "פרויקט" }).skip).toBe("unchanged");
    const rm = applyBulkOp(add, { kind: "removeTag", key: "tags", tag: "A" }).text;
    expect(prop(rm, "tags")).toEqual(["b", "פרויקט"]);
    // A note without the field gets it.
    expect(prop(applyBulkOp("---\nx: 1\n---\n", { kind: "addTag", key: "tags", tag: "t" }).text, "tags")).toEqual(["t"]);
  });
  it("clears a field and converts a type, skipping a lossy conversion", () => {
    const cleared = applyBulkOp(NOTE, { kind: "clear", key: "status" }).text;
    expect(prop(cleared, "status")).toBeUndefined();
    expect(bodyOf(cleared)).toBe(bodyOf(NOTE));
    expect(prop(applyBulkOp("---\nn: \"42\"\n---\n", { kind: "convert", key: "n", to: "number" }).text, "n")).toBe(42);
    expect(applyBulkOp("---\nn: forty\n---\n", { kind: "convert", key: "n", to: "number" }).skip).toBe("lossy");
    expect(applyBulkOp("---\nd: tomorrow\n---\n", { kind: "convert", key: "d", to: "date" }).skip).toBe("lossy");
    expect(prop(applyBulkOp(NOTE, { kind: "convert", key: "tags", to: "text" }).text, "tags")).toBe("a, b");
  });
  it("leaves a note whose frontmatter does not parse, and a key written twice", () => {
    expect(applyBulkOp("---\na: [\n---\n", { kind: "set", key: "a", value: "x" }).skip).toBe("invalid");
    expect(applyBulkOp("---\ntags: a\ntags: b\n---\n", { kind: "set", key: "tags", value: "x" }).skip).toBe("invalid");
  });
  it("keeps CRLF", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    const r = applyBulkOp(crlf, { kind: "set", key: "status", value: "done" }).text;
    expect(r).toBe(crlf.replace("status: todo   #", "status: done   #"));
  });
});

describe("the fast path writes what the YAML path writes", () => {
  it("3,000 random plain frontmatters and operations: byte for byte, or it steps aside", () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const pick = <T,>(xs: readonly T[]) => xs[rnd(xs.length)];
    const plain = ["todo", "done", "עברית", "In progress", "a", "b", "פרויקט", "x-1", "Q3 plan", "2026-11-14", "י״ד בחשוון", "it's"];
    // Values the fast path must step aside for (YAML reads them as numbers, booleans, or they need quotes).
    const tricky = ["a, b", "42", "true", "1.5", "null", "a: b", "#x", " lead"];
    const word = () => (rnd(8) === 0 ? pick(tricky) : pick(plain));
    const keys = ["status", "tags", "שפה", "due", "תאריך עברי", "owner", "aliases"];
    let fast = 0;
    for (let run = 0; run < 3000; run++) {
      const eol = rnd(4) === 0 ? "\r\n" : "\n";
      const lines: string[] = [];
      for (const k of keys) {
        if (rnd(3) === 0) continue;
        if (rnd(6) === 0) lines.push(`# note ${run}`);
        switch (rnd(5)) {
          case 0: lines.push(`${k}: ${word()}`); break;
          case 1: lines.push(`${k}: "${word()}"${rnd(2) ? "   # c" : ""}`); break;
          case 2: lines.push(`${k}: [${Array.from({ length: rnd(3) }, () => word()).join(", ")}]`); break;
          case 3: lines.push(`${k}:`, ...Array.from({ length: 1 + rnd(3) }, () => `${rnd(2) ? "  " : ""}- ${word()}`)); break;
          default: lines.push(`${k}: ${word()}   # why`);
        }
      }
      const text = `---${eol}${lines.join(eol)}${eol}---${eol}# Body${eol}tags: [a]${eol}`;
      const key = pick(keys);
      const op: BulkOp = [
        { kind: "set", key, value: word() } as BulkOp,
        { kind: "clear", key } as BulkOp,
        { kind: "addTag", key, tag: word() } as BulkOp,
        { kind: "removeTag", key, tag: word() } as BulkOp,
      ][rnd(4)];
      const f = fastBulkOp(text, op);
      if (!f) continue;
      fast++;
      const slow = applyBulkOpYaml(text, op);
      expect(f.text, `run ${run}: ${JSON.stringify(op)}\n${text}`).toBe(slow.text);
      expect(!!f.skip, `run ${run}: ${JSON.stringify(op)}\n${text}`).toBe(!!slow.skip);
    }
    // Most of them take the fast path.
    expect(fast).toBeGreaterThan(900);
  });
});

describe("the preview count", () => {
  it("matches what the operation does", () => {
    const notes = [
      { path: "a.md", text: "---\nstatus: todo\ntags: [x]\n---\n" },
      { path: "b.md", text: "---\nstatus: done\n---\n" },
      { path: "c.md", text: "no frontmatter\n" },
    ];
    const ops: BulkOp[] = [
      { kind: "set", key: "status", value: "done" },
      { kind: "clear", key: "status" },
      { kind: "addTag", key: "tags", tag: "x" },
      { kind: "removeTag", key: "tags", tag: "x" },
      { kind: "convert", key: "status", to: "list" },
    ];
    for (const op of ops) {
      const plan = planBulkEdit(notes, op);
      const fms = notes.map((n) => Object.fromEntries(parseProperties(n.text).properties.map((p) => [p.key, p.value])));
      expect(fms.filter((fm) => wouldChange(fm, op)).length, op.kind).toBe(plan.changes.length);
    }
  });
});

describe("selection", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("toggles, and Shift extends from the anchor", () => {
    let s = selectRows(order, new Set(), null, "b", { toggle: true });
    expect([...s.selected]).toEqual(["b"]);
    s = selectRows(order, s.selected, s.anchor, "d", { shift: true, toggle: true });
    expect([...s.selected].sort()).toEqual(["b", "c", "d"]);
    s = selectRows(order, s.selected, s.anchor, "c", { toggle: true });
    expect([...s.selected].sort()).toEqual(["b", "d"]);
    // Shift backwards from the new anchor.
    s = selectRows(order, s.selected, s.anchor, "a", { shift: true, toggle: true });
    expect([...s.selected].sort()).toEqual(["a", "b", "c", "d"]);
    // A plain click (no toggle) selects one.
    expect([...selectRows(order, s.selected, s.anchor, "e", {}).selected]).toEqual(["e"]);
  });
});

describe("1,000 notes", () => {
  const N = 1000;
  const vault: Record<string, string> = {};
  const seed = async () => {
    setVaultBackend(createMemoryBackend());
    __resetBulkUndo();
    for (let i = 0; i < N; i++) {
      const fm = [
        "---",
        ...(i % 3 === 0 ? ["# owner: tal"] : []),
        i % 2 ? `status: "todo"` : "status: todo   # where",
        i % 5 === 0 ? "tags:\n  - a\n  - b" : `tags: [a${i % 7 === 0 ? ", פרויקט" : ""}]`,
        ...(i % 4 === 0 ? ["שפה: עברית"] : []),
        "---",
      ].join("\n");
      const text = `${fm}\n# Note ${i}\n\nstatus: todo in the body. tags: [a]\n${"x".repeat(i % 50)}\n`;
      vault[`n/${i}.md`] = i % 6 === 0 ? text.replace(/\n/g, "\r\n") : text;
    }
    for (const [p, t] of Object.entries(vault)) await writeWorkspaceFile(p, t);
  };

  it("set + add tag change only frontmatter, in ≤ 3 s, and one undo puts all back", async () => {
    await seed();
    const paths = Object.keys(vault);
    const r = await runBulkEdit(paths, { kind: "set", key: "status", value: "done" });
    expect(r.changes.length).toBe(N);
    expect(r.ms).toBeLessThan(3000);
    for (const p of paths) {
      const now = await readWorkspaceFile(p);
      expect(bodyOf(now), p).toBe(bodyOf(vault[p]));
      expect(prop(now, "status")).toBe("done");
    }
    const r2 = await runBulkEdit(paths, { kind: "addTag", key: "tags", tag: "פרויקט" });
    expect(r2.changes.length).toBe(paths.filter((p) => !vault[p].includes("פרויקט")).length);
    expect(r2.ms).toBeLessThan(3000);
    for (const p of paths) expect(bodyOf(await readWorkspaceFile(p))).toBe(bodyOf(vault[p]));
    expect(lastBulkEditAt()).toBeGreaterThan(0);
    // Ctrl+Z: the newest edit first, then the one before.
    const u2 = await undoLastBulkEdit();
    expect(u2?.restored).toBe(r2.changes.length);
    const u1 = await undoBulkChanges(r.changes);
    expect(u1.restored).toBe(N);
    expect(u1.conflicts).toEqual([]);
    for (const p of paths) expect(await readWorkspaceFile(p)).toBe(vault[p]);
    expect(lastBulkEditAt()).toBe(0);
  });

  it("undo leaves a note that changed again since", async () => {
    await seed();
    const paths = ["n/1.md", "n/2.md"];
    const r = await runBulkEdit(paths, { kind: "clear", key: "status" });
    expect(r.changes.length).toBe(2);
    await writeWorkspaceFile("n/2.md", "edited by hand\n");
    const u = await undoBulkChanges(r.changes);
    expect(u.restored).toBe(1);
    expect(u.conflicts).toEqual(["n/2.md"]);
    expect(await readWorkspaceFile("n/1.md")).toBe(vault["n/1.md"]);
    expect(await readWorkspaceFile("n/2.md")).toBe("edited by hand\n");
  });

  it("the batch read keeps a BOM, and a stamped write refuses a file that changed since it was read", async () => {
    setVaultBackend(createMemoryBackend());
    await writeWorkspaceFile("a.md", "\uFEFF---\nx: 1\n---\n");
    await writeWorkspaceFile("b.md", "plain");
    const got = await readWorkspaceTexts(["a.md", "b.md", "missing.md"]);
    expect(got.get("a.md")?.text).toBe("\uFEFF---\nx: 1\n---\n");
    expect(got.get("b.md")?.text).toBe("plain");
    expect(got.has("missing.md")).toBe(false);
    const stamp = got.get("b.md")!.stamp;
    await writeWorkspaceFile("b.md", "changed by someone");
    expect(await writeWorkspaceFileIf("b.md", "bulk", stamp)).toBe(false);
    expect(await readWorkspaceFile("b.md")).toBe("changed by someone");
    const fresh = (await readWorkspaceTexts(["b.md"])).get("b.md")!.stamp;
    expect(await writeWorkspaceFileIf("b.md", "bulk", fresh)).toBe(true);
    expect(await readWorkspaceFile("b.md")).toBe("bulk");
  });
});
