/**
 * Plan 0.19: the rules of the PR gate, `npm run pr:check` (scripts/lib/prGate.mjs).
 * The acceptance line "a PR that adds an unregistered fetch fails" is the
 * first describe block; a `npm run pr:check` run against a real diff is in
 * the PR description.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addedLinesFromDiff,
  licenceChanges,
  skipCiViolations,
  bodyProblems,
  domainMentions,
  REQUIRED_SECTIONS,
  unregisteredNetworkCalls,
  untestedChanges,
  writtenByAi,
  isSnapshotFile,
  SNAPSHOT_TRAILER,
  snapshotEdits,
  // @ts-expect-error -- plain .mjs script, no types
} from "../../scripts/lib/prGate.mjs";

const LEDGER = readFileSync(join(__dirname, "../ai/privacyLedger.ts"), "utf8");

function diffOf(file: string, lines: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +1,${lines.length + 1} @@`, " const x = 1;", ...lines.map((l) => `+${l}`)].join("\n");
}

describe("network calls must be in the privacy ledger", () => {
  it("fails a new fetch to a host the ledger does not know", () => {
    const added = addedLinesFromDiff(diffOf("src/ai/newThing.ts", ['  const r = await fetch("https://api.example-tracker.io/v1/collect", { method: "POST" });']));
    const v = unregisteredNetworkCalls(added, LEDGER);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: "src/ai/newThing.ts", line: 2 });
    expect(v[0].why).toMatch(/api\.example-tracker\.io/);
  });

  it("passes a new call to a host the ledger has a rule for, and the local machine", () => {
    const added = addedLinesFromDiff(
      diffOf("src/ai/x.ts", [
        '  await fetch("https://api.anthropic.com/v1/messages", init);',
        '  const ws = new WebSocket("ws://localhost:11434/api");',
      ]),
    );
    expect(unregisteredNetworkCalls(added, LEDGER)).toEqual([]);
  });

  it("asks a call with a computed URL for a `privacy-ledger:` note, on its line or the two above", () => {
    const bare = addedLinesFromDiff(diffOf("src/sync/y.ts", ["  const res = await fetch(url);"]));
    expect(unregisteredNetworkCalls(bare, LEDGER)[0].why).toMatch(/privacy-ledger/);
    const noted = addedLinesFromDiff(diffOf("src/sync/y.ts", ["  // privacy-ledger: research endpoint (atEndpoint, category research)", "  const res = await fetch(url);"]));
    expect(unregisteredNetworkCalls(noted, LEDGER)).toEqual([]);
  });

  it("covers WebSocket, EventSource, XMLHttpRequest, sendBeacon and fetchWithRetry", () => {
    const lines = [
      '  new WebSocket("wss://relay.unknown.net");',
      '  new EventSource("https://events.unknown.net");',
      "  const x = new XMLHttpRequest();",
      '  navigator.sendBeacon("https://beacon.unknown.net", data);',
      '  await fetchWithRetry("https://retry.unknown.net/a");',
    ];
    expect(unregisteredNetworkCalls(addedLinesFromDiff(diffOf("src/lib/z.ts", lines)), LEDGER)).toHaveLength(5);
  });

  it("ignores tests, comments and files outside src/", () => {
    expect(unregisteredNetworkCalls(addedLinesFromDiff(diffOf("src/__tests__/a.test.ts", ['fetch("https://x.unknown.io")'])), LEDGER)).toEqual([]);
    expect(unregisteredNetworkCalls(addedLinesFromDiff(diffOf("scripts/fetch-model.mjs", ['await fetch("https://x.unknown.io")'])), LEDGER)).toEqual([]);
    expect(unregisteredNetworkCalls(addedLinesFromDiff(diffOf("src/a.ts", ['  // we used to fetch("https://x.unknown.io") here'])), LEDGER)).toEqual([]);
  });
});

describe("the other rules", () => {
  it("flags production code changed with no test at all", () => {
    expect(untestedChanges(["src/lib/a.ts", "README.md"])).toEqual(["src/lib/a.ts"]);
    expect(untestedChanges(["src/lib/a.ts", "src/__tests__/a.test.ts"])).toEqual([]);
    expect(untestedChanges(["src/lib/a.ts", "e2e/a.spec.ts"])).toEqual([]);
    expect(untestedChanges(["docs/a.md"])).toEqual([]);
  });

  it("recognises a PR written by an AI agent", () => {
    expect(writtenByAi("", ["fix: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"])).toBe(true);
    expect(writtenByAi("🤖 Generated with [Claude Code](https://claude.com/claude-code)", [])).toBe(true);
    expect(writtenByAi("A human change", ["fix: typo"])).toBe(false);
  });

  it("lists production packages whose licence is new or changed, and fails copyleft and missing ones", () => {
    const base = { packages: { "node_modules/a": { version: "1.0.0", license: "MIT" }, "node_modules/b": { version: "1.0.0", license: "MIT" } } };
    const head = {
      packages: {
        "node_modules/a": { version: "1.0.0", license: "MIT" },
        "node_modules/b": { version: "2.0.0", license: "GPL-3.0-only" },
        "node_modules/c": { version: "1.0.0", license: "Apache-2.0" },
        "node_modules/d": { version: "1.0.0" },
        "node_modules/e": { version: "1.0.0", license: "LGPL-2.1" },
        "node_modules/devtool": { version: "1.0.0", license: "GPL-3.0", dev: true },
      },
    };
    const rows = licenceChanges(base, head);
    expect(rows.map((r: { name: string; level: string }) => `${r.name}:${r.level}`)).toEqual(["b:fail", "c:ok", "d:fail", "e:warn"]);
  });

  it("every commit subject carries [skip ci]", () => {
    expect(skipCiViolations(["feat: a [skip ci]", "fix: b", "docs: c [skip ci]"])).toEqual(["fix: b"]);
  });

  it("the PR body has every required section, none empty", () => {
    const full = REQUIRED_SECTIONS.map((h: string) => `${h}\n\ntext`).join("\n\n");
    expect(bodyProblems(full)).toEqual([]);
    expect(bodyProblems(full.replace("## Not verified here\n\ntext", "## Not verified here\n\n"))).toEqual(['section "## Not verified here" is empty']);
    expect(bodyProblems("## What and why\n\nx")).toContain('missing section "## Owner commands"');
    // A deeper heading inside a section is content, not the next section.
    expect(bodyProblems(full.replace("## Local verification\n\ntext", "## Local verification\n\n### Ran\n- tests"))).toEqual([]);
  });

  it("an added line that names the project's domain is flagged", () => {
    const dom = ["lumen", "md"].join(".");
    const added = addedLinesFromDiff(diffOf("docs/x.md", [`See https://${dom}/docs`, "the file README.md", `src/lumen.mdx`]));
    expect(domainMentions(added).map((m: { line: number }) => m.line)).toEqual([2]);
  });
});

describe("snapshots are regenerated, never hand-edited (plan W6.15)", () => {
  const snap = "src/__tests__/__snapshots__/commandIds.test.ts.snap";
  const regen = (how: string) => `test: regenerate the command ids snapshot [skip ci]\n\n${SNAPSHOT_TRAILER}: ${how}`;

  it("knows snapshot files from vitest and Playwright", () => {
    expect(isSnapshotFile(snap)).toBe(true);
    expect(isSnapshotFile("src/__tests__/__snapshots__/render/doc-deploy.html")).toBe(true);
    expect(isSnapshotFile("e2e/visual-smoke.spec.ts-snapshots/home-chromium.png")).toBe(true);
    expect(isSnapshotFile("src/__tests__/commandIds.test.ts")).toBe(false);
  });

  it("fails a snapshot changed with no trailer — the hand edits of #465, #468, #471, #475, #487, #488", () => {
    const r = snapshotEdits([{ sha: "abcdef1234", message: "feat: a new command [skip ci]", files: ["src/commands.ts", snap] }]);
    expect(r).toHaveLength(1);
    expect(r[0].why).toContain(SNAPSHOT_TRAILER);
  });

  it("passes a regeneration on its own commit that names the -u command and the host", () => {
    expect(snapshotEdits([{ sha: "1", message: regen("npx vitest run src/__tests__/commandIds.test.ts -u on mac-mini"), files: [snap] }])).toEqual([]);
    expect(snapshotEdits([{ sha: "2", message: regen("npx playwright test visual-smoke --update-snapshots on vercel-sandbox"), files: ["e2e/visual-smoke.spec.ts-snapshots/a.png"] }])).toEqual([]);
  });

  it("fails a trailer without the update command or the host, and a regeneration mixed with code", () => {
    expect(snapshotEdits([{ sha: "3", message: regen("edited by hand"), files: [snap] }])).toHaveLength(1);
    expect(snapshotEdits([{ sha: "4", message: regen("npx vitest -u"), files: [snap] }])).toHaveLength(1);
    const mixed = snapshotEdits([{ sha: "5", message: regen("npx vitest -u on mac-mini"), files: [snap, "src/commands.ts"] }]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0].why).toContain("commit of its own");
  });

  it("ignores commits that touch no snapshot", () => {
    expect(snapshotEdits([{ sha: "6", message: "fix: x", files: ["src/a.ts"] }])).toEqual([]);
  });
});
