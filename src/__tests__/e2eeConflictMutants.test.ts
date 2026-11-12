/**
 * Plan 0.15 / W4.17 — tests written for mutants that survived the e2ee
 * suites in the conflict helpers: binary sides never reach the dialog, and
 * conflict copy names count up past taken names. (The keyring cases of
 * #427's e2eeMutants.test.ts come with the keyring module, which is not on
 * this branch yet.) Merge first (W1.9): only text on all three sides is
 * merged; anything else goes to the next resolver untouched.
 */
import { describe, expect, it } from "vitest";
import { asText, conflictCopyPath, dialogResolver, mergeFirst, type ConflictInput, type ConflictResolver } from "../sync/e2ee/conflict";

describe("conflict helpers", () => {
  it("reads text and refuses binary (NUL or invalid UTF-8)", () => {
    expect(asText(new TextEncoder().encode("שלום"))).toBe("שלום");
    expect(asText(new Uint8Array([104, 0, 105]))).toBe(null);
  });

  it("keeps both sides of a binary conflict without opening the dialog", async () => {
    const bin = new Uint8Array([0, 1, 2]);
    const txt = new TextEncoder().encode("text");
    expect(await dialogResolver({ path: "a.png", local: bin, remote: txt, base: null } as never)).toEqual({ kind: "keepBoth" });
    expect(await dialogResolver({ path: "a.png", local: txt, remote: bin, base: null } as never)).toEqual({ kind: "keepBoth" });
  });

  it("names conflict copies, counting up past taken names", () => {
    expect(conflictCopyPath("notes/a.md", "laptop", () => false)).toBe("notes/a (conflict laptop).md");
    const taken = new Set(["notes/a (conflict laptop).md", "notes/a (conflict laptop 2).md"]);
    expect(conflictCopyPath("notes/a.md", "laptop", (p) => taken.has(p))).toBe("notes/a (conflict laptop 3).md");
    expect(conflictCopyPath("README", "x", () => false)).toBe("README (conflict x)");
    expect(conflictCopyPath(".env", "x", () => false)).toBe(".env (conflict x)");
  });

  it("merges text only when base, mine and theirs are all text; otherwise asks the next resolver, keeping nothing", async () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const bin = new Uint8Array([0, 1, 2]);
    const asked: ConflictInput[] = [];
    const kept: string[][] = [];
    const next: ConflictResolver = async (c) => {
      asked.push(c);
      return { kind: "keepBoth" };
    };
    const resolve = mergeFirst(next, async (p, ours, theirs) => void kept.push([p, ours, theirs]));
    const clean = await resolve({ path: "n.md", base: enc("a\nb\nc\n"), local: enc("A\nb\nc\n"), remote: enc("a\nb\nC\n") });
    expect(clean.kind === "content" && new TextDecoder().decode(clean.data)).toBe("A\nb\nC\n");
    expect(kept).toEqual([["n.md", "A\nb\nc\n", "a\nb\nC\n"]]);
    expect(asked).toEqual([]);
    const cases: ConflictInput[] = [
      { path: "1", base: enc("a\n"), local: bin, remote: enc("b\n") },
      { path: "2", base: enc("a\n"), local: enc("b\n"), remote: bin },
      { path: "3", base: bin, local: enc("a\nx\n"), remote: enc("a\ny\n") },
      { path: "4", base: null, local: enc("a\n"), remote: enc("b\n") },
      { path: "5", base: enc("a\n"), local: enc("b\n"), remote: enc("c\n") }, // both changed the same line
    ];
    for (const c of cases) expect(await resolve(c), c.path).toEqual({ kind: "keepBoth" });
    expect(asked).toEqual(cases);
    expect(kept).toHaveLength(1);
  });
});
