import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plan W10.B15 (audit W4.23): tools/native-check/real-cargo.sh printed
 * "ok cargo check --locked" when cargo failed with "failed to download", so
 * a check that stopped before compiling anything read as a pass.
 *
 * The real script runs here. Only `cargo` is replaced, by a stand-in on
 * PATH that prints what real cargo prints in each case: the download
 * failure is cargo's own message when it has an index but no crate sources.
 */
const SCRIPT = join(__dirname, "..", "..", "tools", "native-check", "real-cargo.sh");

type Mode = "download" | "compiled" | "compile-error";

function run(mode: Mode, opts: { pathCrate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "real-cargo-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const cargo = join(bin, "cargo");
    writeFileSync(
      cargo,
      `#!/bin/bash
case "$1" in
  check)
    case "$FAKE_CARGO_MODE" in
      download) echo "    Updating \\\`index\\\` index"; echo "error: failed to download \\\`serde v1.0.219\\\`"; echo ""; echo "Caused by:"; echo "  attempting to make an HTTP request, but --offline was specified"; exit 101;;
      compiled) echo "    Finished \\\`dev\\\` profile [unoptimized + debuginfo] target(s) in 1.00s"; exit 0;;
      compile-error) echo "error[E0425]: cannot find value \\\`x\\\` in this scope"; exit 101;;
    esac;;
  test) echo "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"; exit 0;;
esac
exit 1
`,
    );
    chmodSync(cargo, 0o755);
    const index = join(dir, "index");
    mkdirSync(index);
    writeFileSync(join(index, "config.json"), '{"dl":"https://static.crates.io/crates"}');
    const tauri = join(dir, "src-tauri");
    mkdirSync(tauri);
    writeFileSync(join(tauri, "Cargo.toml"), '[package]\nname = "app"\n[dependencies]\nserde = "1"\n');
    if (opts.pathCrate) {
      mkdirSync(join(tauri, "desktop"));
      writeFileSync(join(tauri, "desktop", "Cargo.toml"), '[package]\nname = "desktop"\n[dependencies]\n');
    }
    const r = spawnSync("bash", [SCRIPT, tauri, index], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_CARGO_MODE: mode },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("real-cargo.sh (W10.B15)", () => {
  it("a download failure is UNKNOWN with exit 3, never ok", () => {
    const r = run("download");
    expect(r.out).not.toMatch(/^ok\s+cargo check/m);
    expect(r.out).toMatch(/^UNKNOWN cargo check --locked: .*failed to download/m);
    expect(r.out).toMatch(/result: UNKNOWN \(exit 3\)/);
    expect(r.code).toBe(3);
  });

  it("a download failure stays UNKNOWN when a path crate's tests pass", () => {
    const r = run("download", { pathCrate: true });
    expect(r.out).toMatch(/^ok\s+cargo test desktop: ok\. 2 passed/m);
    expect(r.out).not.toMatch(/^ok\s+cargo check/m);
    expect(r.code).toBe(3);
  });

  it("a compile error is FAIL with exit 1", () => {
    const r = run("compile-error");
    expect(r.out).toMatch(/^FAIL cargo check --locked/m);
    expect(r.code).toBe(1);
  });

  it("only a check that compiled says ok, with exit 0", () => {
    const r = run("compiled");
    expect(r.out).toMatch(/^ok\s+cargo check --locked: compiled/m);
    expect(r.code).toBe(0);
  });

  it("with no path crates the script does not run cargo test on a glob that matched nothing", () => {
    const r = run("compiled");
    expect(r.out).not.toMatch(/cargo test/);
  });
});
