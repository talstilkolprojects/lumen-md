import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Plan W10.B4 (audit 11.2, 12.2): src/plugins/sandbox.ts was dead code with
 * a frame CSP of `script-src 'unsafe-inline' 'unsafe-eval' https: data:;
 * connect-src https:` — any HTTPS script, any HTTPS request — waiting for
 * someone to wire it up. It is deleted, and no shipped source may carry a
 * CSP that lets scripts load from, or requests go to, any HTTPS origin.
 */
const root = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|html)$/.test(name)) out.push(p);
  }
  return out;
}

/** Each `<directive> …;` of every CSP-looking string in the file. */
function cspDirectives(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/((?:default|script|connect)-src)\s([^;"`]*)/g)) out.push(`${m[1]} ${m[2].trim()}`);
  return out;
}

describe("no weak plugin CSP (W10.B4)", () => {
  it("the dead plugin sandbox is gone", () => {
    expect(existsSync(join(root, "src/plugins/sandbox.ts"))).toBe(false);
  });

  it("the unused-files baseline no longer lists it", () => {
    const baseline = JSON.parse(readFileSync(join(root, "scripts/unused-files.baseline.json"), "utf8")) as { files: string[] };
    expect(baseline.files).not.toContain("src/plugins/sandbox.ts");
  });

  it("no shipped source allows scripts or requests to any https: origin", () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, "src"))) {
      for (const d of cspDirectives(readFileSync(file, "utf8"))) {
        if (/(^|\s)https:(\s|$)/.test(d.replace(/^\S+\s/, " "))) offenders.push(`${relative(root, file)}: ${d}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
