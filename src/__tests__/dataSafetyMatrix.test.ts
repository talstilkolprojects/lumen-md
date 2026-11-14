import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plan 3.7 — the data-safety P0 gate: every data-loss path G1–G11 keeps an
 * e2e scenario. A scenario is a Playwright test whose title starts with its
 * G ids ("G5, G6: …"). G8 (sync providers) lives with the providers
 * (plan 3.5, e2e/sync-providers.spec.ts); it counts when that spec exists.
 */
const root = join(__dirname, "..", "..");
const read = (p: string) => {
  try {
    return readFileSync(join(root, p), "utf8");
  } catch {
    return "";
  }
};

function coveredIds(src: string): Set<string> {
  const ids = new Set<string>();
  for (const m of src.matchAll(/^test\("((?:G\d+(?:, )?)+):/gm)) for (const id of m[1].split(", ")) ids.add(id);
  return ids;
}

describe("data-safety matrix (plan 3.7)", () => {
  const ids = coveredIds(read("e2e/data-safety.spec.ts"));
  const providers = read("e2e/sync-providers.spec.ts");
  if (/\bG8\b/.test(providers)) ids.add("G8");

  for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) {
    it(`G${n} has an e2e scenario in e2e/data-safety.spec.ts`, () => {
      expect(ids.has(`G${n}`)).toBe(true);
    });
  }

  it("G8 is open on this branch until the plan 3.5 provider e2e is merged in", () => {
    // Plan 3.7.1: G8 stays open (and the P0 gate with it) until 3.5 connects
    // the providers and runs G8 on the user's path.
    expect(ids.has("G8")).toBe(providers.length > 0);
  });
});
