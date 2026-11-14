/**
 * Plan 3.3: a commit copies the vault into the git mirror without forcing
 * a shape change. A file in the vault where the mirror has a folder (or the
 * reverse), left that way by a clone into an existing folder, is skipped and
 * reported; neither side is deleted and the rest is written.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeIntoMirror } from "../sync/gitMirror";

let dir: string;
const enc = (s: string) => new TextEncoder().encode(s);
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-mirror-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("writeIntoMirror", () => {
  it("writes files and creates missing folders", async () => {
    const { skipped } = await writeIntoMirror(fs, dir, [
      { relative: "a.md", bytes: enc("a") },
      { relative: "notes/deep/b.md", bytes: enc("b") },
    ]);
    expect(skipped).toEqual([]);
    expect(read("a.md")).toBe("a");
    expect(read("notes/deep/b.md")).toBe("b");
  });

  it("skips a vault file where the mirror has a folder, and keeps the folder", async () => {
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs/readme.md"), "remote");
    const { skipped } = await writeIntoMirror(fs, dir, [
      { relative: "docs", bytes: enc("local file") },
      { relative: "other.md", bytes: enc("o") },
    ]);
    expect(skipped).toEqual(["docs"]);
    expect(read("docs/readme.md")).toBe("remote");
    expect(read("other.md")).toBe("o");
  });

  it("skips a vault file under a folder that is a file in the mirror, and keeps that file", async () => {
    fs.writeFileSync(path.join(dir, "x"), "remote file");
    const { skipped } = await writeIntoMirror(fs, dir, [{ relative: "x/inner.md", bytes: enc("local") }]);
    expect(skipped).toEqual(["x/inner.md"]);
    expect(read("x")).toBe("remote file");
  });
});
