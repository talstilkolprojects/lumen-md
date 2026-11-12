/**
 * Plan 0.15 / W4.17 — tests written for mutants that survived the e2ee
 * suites in the conflict helpers: binary sides never reach the dialog, and
 * conflict copy names count up past taken names. (The keyring cases of
 * #427's e2eeMutants.test.ts come with the keyring module, which is not on
 * this branch yet.)
 */
import { describe, expect, it } from "vitest";
import { asText, conflictCopyPath, dialogResolver } from "../sync/e2ee/conflict";

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
});
