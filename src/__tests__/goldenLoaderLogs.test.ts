// @vitest-environment node
/**
 * #225 P1 (round 2): run-evals.mjs publishes each set's error to the public
 * Actions log and job summary. A loadSet() failure must be reported by type
 * only, unless it is a GoldenPublicError (set/part ids from the manifest).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs module without type declarations
import { GoldenPublicError, publicLoaderError } from "../../scripts/lib/golden.mjs";

describe("run-evals withholds loader messages", () => {
  it("a JSON.parse error's fragment of held-out text never appears", () => {
    let err: unknown;
    try {
      JSON.parse('{"items":[{"id":"q1","prompt":"HELDOUT-SECRET" oops}]}');
    } catch (e) {
      err = e;
    }
    const msg = publicLoaderError(err);
    expect(msg).toContain("SyntaxError");
    expect(msg).not.toMatch(/HELDOUT|oops|prompt/);
    expect(publicLoaderError(new Error("item SECRET-ID does not match"))).not.toContain("SECRET-ID");
    expect(publicLoaderError(Object.assign(new Error("/tmp/split/SECRET.json"), { code: "ENOENT" }))).toMatch(/ENOENT/);
    expect(publicLoaderError(Object.assign(new Error("/tmp/split/SECRET.json"), { code: "ENOENT" }))).not.toContain("SECRET");
  });

  it("a GoldenPublicError (manifest ids only) is kept, as the one diagnostic worth reading", () => {
    expect(publicLoaderError(new GoldenPublicError("asr-he/fleurs: the test split does not match its recorded sha256"))).toBe("asr-he/fleurs: the test split does not match its recorded sha256");
  });

  it("run-evals.mjs routes loader failures through publicLoaderError, never e.message", () => {
    const src = readFileSync("scripts/golden/run-evals.mjs", "utf8");
    expect(src).not.toMatch(/e\.message/);
    expect(src).toMatch(/error: publicLoaderError\(e\)/);
  });
});
