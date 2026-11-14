// @vitest-environment node
/**
 * scripts/ci-doctor.mjs end to end against a fake `gh` on PATH that serves
 * canned REST responses (and pages arrays by per_page/page like the API):
 * which run it picks, that it reads every page of annotations, and that a
 * green peer only counts as a pass of a test that existed there.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(__dirname, "../../scripts/ci-doctor.mjs");

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const routes = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ROUTES, "utf8"));
const args = process.argv.slice(2);
const route = args[1];
const q = new URLSearchParams(route.split("?")[1] ?? "");
for (const [re, body] of routes) {
  if (!new RegExp(re).test(route)) continue;
  let out = body;
  if (Array.isArray(body) && !args.includes("--paginate")) {
    const per = Number(q.get("per_page") ?? 30);
    const page = Number(q.get("page") ?? 1);
    out = body.slice((page - 1) * per, page * per);
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
process.stderr.write("gh: Not Found (HTTP 404) " + route + "\\n");
process.exit(1);
`;

const S1 = "1".repeat(40);
const S2 = "2".repeat(40);
const run = (id: number, name: string, workflow_id: number, conclusion: string, sha: string, branch: string, at: string) => ({ id, name, workflow_id, status: "completed", conclusion, head_sha: sha, head_branch: branch, created_at: at, html_url: `https://ci/${id}` });
const ciRun = run(100, "CI", 11, "failure", S1, "feat/x", "2026-10-18T05:00:00Z");
const tauriRun = run(101, "Tauri", 22, "success", S1, "feat/x", "2026-10-18T05:10:00Z");
const peerRun = run(200, "CI", 11, "success", S2, "feat/y", "2026-10-18T04:00:00Z");
const job = (id: number, conclusion: string) => ({ id, name: "e2e (chromium)", status: "completed", conclusion, html_url: `https://job/${id}`, steps: [{ number: 1, name: "Run E2E (chromium)", status: "completed", conclusion }] });
const fail = (path: string, line: number, name: string) => ({ annotation_level: "failure", path, start_line: line, title: `[chromium] › ${path}:${line}:1 › ${name}`, message: "Error: expect(received).toBe(expected)" });
// 122 annotations: the second failing test is on page 2.
const annotations = [
  fail("e2e/old.spec.ts", 10, "an old test fails"),
  ...Array.from({ length: 120 }, (_, i) => ({ annotation_level: "warning", path: "e2e/old.spec.ts", start_line: i + 1, title: "slow test", message: "slow" })),
  fail("e2e/new.spec.ts", 5, "a brand new test fails"),
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROUTES: Array<[string, unknown]> = [
  ["^repos/o/r/pulls/7$", { number: 7, head: { ref: "feat/x", sha: S1 } }],
  [`^${esc("repos/o/r/actions/workflows/ci.yml/runs?branch=feat%2Fx")}`, { workflow_runs: [ciRun] }],
  // Every workflow of the branch: the newest is Tauri (it runs on each PR label event).
  [`^${esc("repos/o/r/actions/runs?branch=feat%2Fx")}`, { workflow_runs: [tauriRun, ciRun] }],
  ["^repos/o/r/actions/runs/100$", ciRun],
  ["^repos/o/r/actions/runs/100/jobs", { jobs: [job(1000, "failure")] }],
  ["^repos/o/r/check-runs/1000/annotations", annotations],
  [`^${esc("repos/o/r/actions/workflows/11/runs?status=completed")}`, { workflow_runs: [peerRun, ciRun] }],
  ["^repos/o/r/actions/runs/200/jobs", { jobs: [job(2000, "success")] }],
  ["^repos/o/r/check-runs/2000/annotations", []],
  // This branch added e2e/new.spec.ts since the merge base; feat/y changed something else.
  [`^${esc(`repos/o/r/compare/${S2}...${S1}`)}$`, { a: 2, b: 3, n: 1, files: ["e2e/new.spec.ts"] }],
  [`^${esc(`repos/o/r/compare/${S1}...${S2}`)}$`, { a: 3, b: 2, n: 1, files: ["src/other.ts"] }],
];

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lumen-ci-doctor-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "routes.json"), JSON.stringify(ROUTES));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function doctor(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "o/r", FAKE_GH_ROUTES: join(dir, "routes.json") },
  });
  expect(r.stderr).toBe("");
  return JSON.parse(r.stdout);
}
type Failure = { title: string; path: string; verdict: string; why: string };

describe("scripts/ci-doctor.mjs (fake gh)", () => {
  it("fails visibly when the diagnosed run's jobs cannot be read", () => {
    const routes = join(dir, "routes-no-jobs.json");
    writeFileSync(routes, JSON.stringify(ROUTES.filter(([re]) => !re.includes("runs/100/jobs"))));
    const r = spawnSync(process.execPath, [cli, "--run", "100", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "o/r", FAKE_GH_ROUTES: routes },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("ci-doctor: could not read the jobs of run 100");
    expect(r.stdout).toBe("");
  });

  it("diagnoses the CI workflow's run, not a newer run of another workflow", () => {
    const out = doctor("7");
    expect(out.run.id).toBe(100);
    expect(out.verdict).not.toBe("green");
    expect(out.failures.length).toBeGreaterThan(0);
  });

  it("reads every page of a job's annotations", () => {
    const out = doctor("--run", "100");
    expect(out.failures.map((f: Failure) => f.path).sort()).toEqual(["e2e/new.spec.ts", "e2e/old.spec.ts"]);
  });

  it("a green peer is a pass only of a test whose file is the same there", () => {
    const out = doctor("--run", "100");
    const by = Object.fromEntries(out.failures.map((f: Failure) => [f.path, f]));
    // Unchanged on both sides: the peer ran it, and it passed.
    expect(by["e2e/old.spec.ts"]).toMatchObject({ verdict: "flake?" });
    // Added on this branch: the peer never had it, so its green job says nothing.
    expect(by["e2e/new.spec.ts"].verdict).toBe("unknown");
    expect(by["e2e/new.spec.ts"].why).toMatch(/file differs there/);
  });

  it("a peer that changed the test setup (playwright.config.ts) is no pass either (W1.32, #204)", () => {
    const routes = join(dir, "routes-setup.json");
    const changed = ROUTES.map(([re, body]) => (re === `^${esc(`repos/o/r/compare/${S1}...${S2}`)}$` ? [re, { a: 3, b: 2, n: 2, files: ["src/other.ts", "playwright.config.ts"] }] : [re, body]));
    writeFileSync(routes, JSON.stringify(changed));
    const r = spawnSync(process.execPath, [cli, "--run", "100", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "o/r", FAKE_GH_ROUTES: routes },
    });
    const by = Object.fromEntries(JSON.parse(r.stdout).failures.map((f: Failure) => [f.path, f]));
    expect(by["e2e/old.spec.ts"].verdict).toBe("unknown");
    expect(by["e2e/old.spec.ts"].why).toMatch(/test-setup file differs there/);
  });

  it("--around takes peers from a time window around the failing run, nearest first (plan 0.9: #189 vs #191)", () => {
    // The newest 60 runs no longer hold the peer that ran the same test; the window does.
    const oldPeer = run(300, "CI", 11, "success", S2, "feat/y", "2026-10-18T05:30:00Z");
    const farPeer = run(301, "CI", 11, "success", S2, "feat/z", "2026-10-19T20:00:00Z");
    const routes = join(dir, "routes-around.json");
    const windowRe = esc("repos/o/r/actions/workflows/11/runs?status=completed&created=") + esc(encodeURIComponent("2026-10-16T05:00:00Z..2026-10-20T05:00:00Z"));
    writeFileSync(
      routes,
      JSON.stringify([
        [`^${windowRe}`, { workflow_runs: [farPeer, ciRun, oldPeer] }],
        [`^${esc("repos/o/r/actions/workflows/11/runs?status=completed")}`, { workflow_runs: [] }],
        ["^repos/o/r/actions/runs/30[01]/jobs", { jobs: [job(3000, "success")] }],
        ["^repos/o/r/check-runs/3000/annotations", []],
        ...ROUTES,
      ]),
    );
    const r = spawnSync(process.execPath, [cli, "--around", "100", "--peers", "1", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "o/r", FAKE_GH_ROUTES: routes },
    });
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.run.id).toBe(100);
    expect(out.peers).toBe(1);
    expect(out.notes.some((n: string) => /peers: runs of this workflow from 2026-10-16 05:00 UTC to 2026-10-20 05:00 UTC/.test(n))).toBe(true);
    // The old e2e test passed in the nearest run of the window.
    expect(out.failures.find((f: Failure) => f.path === "e2e/old.spec.ts").verdict).toBe("flake?");
    const plain = doctor("--run", "100");
    expect(plain.notes.some((n: string) => n.startsWith("peers:"))).toBe(false);
  });

  it("--window must be positive", () => {
    const r = spawnSync(process.execPath, [cli, "--around", "100", "--window", "0"], { encoding: "utf8", env: { ...process.env, GH_REPO: "o/r" } });
    expect(r.status).toBe(2);
  });
});
