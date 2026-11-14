// @vitest-environment node
/**
 * Crypto review 6's condition for 0.2.0-beta.1 (plan W6.43): no UI that
 * re-keys, revokes or enrolls a device until H1 (`rekeyBlocked` bound to the
 * epoch) is fixed. Pairing, which the review covered, stays. A source scan:
 * only the sync core may call rekey() or enroll().
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== "__tests__") sources(p, out);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

describe("encrypted sync in 0.2.0-beta.1 (W6.43): no re-key, revoke or enroll UI", () => {
  it("no UI re-keys, revokes or enrolls: only the sync core calls rekey() and enroll() (H1 first)", () => {
    const core = join(SRC, "sync", "e2ee");
    const callers = sources(SRC)
      .filter((f) => {
        const rel = relative(core, f);
        // The core modules directly in src/sync/e2ee/ (engine, keyring…) may; ui/, classroom/, lan/… may not.
        return rel.startsWith("..") || rel.includes("/");
      })
      .filter((f) => /\.(rekey|enroll)\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(callers).toEqual([]);
  });

  it("the scan would catch one", () => {
    expect(/\.(rekey|enroll)\s*\(/.test("void engine.rekey({ revoke: [id] })")).toBe(true);
  });
});
