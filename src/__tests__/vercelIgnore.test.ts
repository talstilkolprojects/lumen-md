import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "vercel-ignore.sh");

/**
 * Vercel caps `ignoreCommand` at 256 characters and reads exit code 0 as
 * "skip the build". The real logic lives in scripts/vercel-ignore.sh; these
 * tests pin both the config contract and the script's decisions.
 */
describe("the Vercel config's ignoreCommand", () => {
  // vercel.json is deploy/vercel.base.json, read through vercel.ts (#239).
  const cfg = JSON.parse(readFileSync(join(ROOT, "deploy", "vercel.base.json"), "utf8")) as {
    ignoreCommand?: string;
  };

  it("stays within Vercel's 256-character limit", () => {
    expect(cfg.ignoreCommand).toBeTruthy();
    expect(cfg.ignoreCommand!.length).toBeLessThanOrEqual(256);
  });

  it("delegates to a script that exists in the repo", () => {
    expect(cfg.ignoreCommand).toBe("bash scripts/vercel-ignore.sh");
    expect(existsSync(SCRIPT)).toBe(true);
  });

  // vercel.ts compiles the config only after Vercel's Ignored Build Step has
  // run, so the config's ignoreCommand is never read: the rule takes effect
  // through the project setting (Settings → Git → Ignored Build Step), which
  // must be this same command. The checks page says so in both languages.
  it("the project's Ignored Build Step is the same command, and the docs say it must be set", () => {
    const PROJECT_IGNORE_COMMAND = "bash scripts/vercel-ignore.sh";
    expect(cfg.ignoreCommand).toBe(PROJECT_IGNORE_COMMAND);
    for (const doc of ["docs/src/content/docs/contributing/checks.md", "docs/src/content/docs/he/contributing/checks.md"]) {
      const text = readFileSync(join(ROOT, doc), "utf8");
      expect(text, doc).toContain(`\`${PROJECT_IGNORE_COMMAND}\``);
      expect(text, doc).toContain("Ignored Build Step");
    }
  });
});

/** The environment without Vercel's git variables (a Vercel build sets them for vitest too). */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VERCEL_GIT_COMMIT_REF;
  delete env.VERCEL_GIT_COMMIT_SHA;
  delete env.LUMEN_BUILD_ALL;
  return { ...env, ...extra };
}

describe("scripts/vercel-ignore.sh", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();

  /** Returns the script's exit code for a commit touching exactly `files`. */
  function decide(files: string[]): number {
    for (const f of files) {
      mkdirSync(join(repo, dirname(f)), { recursive: true });
      writeFileSync(join(repo, f), `// ${Math.random()}\n`, { flag: "a" });
      git("add", "-f", f);
    }
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", files.join(" "));
    try {
      execFileSync("bash", ["scripts/vercel-ignore.sh"], { cwd: repo, stdio: "ignore", env: cleanEnv() });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "lumen-vercel-ignore-"));
    git("init", "-q");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    cpSync(SCRIPT, join(repo, "scripts", "vercel-ignore.sh"));
    // Minimal src/ with one import that reaches outside src/, mirroring
    // src/research/citations.ts → edge-workers/research/extract.ts.
    mkdirSync(join(repo, "src", "research"), { recursive: true });
    mkdirSync(join(repo, "src", "__tests__"), { recursive: true });
    writeFileSync(
      join(repo, "src", "research", "citations.ts"),
      'import { normaliseForMatch } from "../../edge-workers/research/extract";\nexport { normaliseForMatch };\n',
    );
    writeFileSync(
      join(repo, "src", "__tests__", "w.test.ts"),
      'import w from "../../edge-workers/auth/worker";\nexport default w;\n',
    );
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const SKIP = 0;
  const BUILD = 1;

  it("skips docs-only and other-deployable-only changes", () => {
    expect(decide(["MASTER_PLAN.md"])).toBe(SKIP);
    expect(decide(["docs/src/content/docs/x.md"])).toBe(SKIP);
    expect(decide(["edge-workers/research/worker.ts"])).toBe(SKIP);
    expect(decide(["mcp-server/src/frontmatter.ts"])).toBe(SKIP);
    expect(decide([".github/workflows/ci.yml"])).toBe(SKIP);
    expect(decide(["sync-server/server.js"])).toBe(SKIP);
    // The sealed nightly reports (W4.36) are committed by the nightly run.
    expect(decide(["reports/nightly/2026-11-13-flake.json", "reports/nightly/status.json"])).toBe(SKIP);
  });

  it("builds when a module outside src/ that src/ imports changes", () => {
    expect(decide(["edge-workers/research/extract.ts"])).toBe(BUILD);
  });

  it("does not treat test-only imports as app inputs", () => {
    expect(decide(["edge-workers/auth/worker.ts"])).toBe(SKIP);
  });

  it("builds for app inputs, including markdown served from public/", () => {
    expect(decide(["src/lib/x.ts"])).toBe(BUILD);
    expect(decide(["public/plugins/CONTEST.md"])).toBe(BUILD);
    expect(decide(["vercel.json"])).toBe(BUILD);
    expect(decide(["package-lock.json"])).toBe(BUILD);
    expect(decide(["docs/a.md", "src/lib/y.ts"])).toBe(BUILD);
  });

  it("skips a commit that is no longer its branch's head; reads nothing it cannot reach", () => {
    // A remote whose branch "verify/train" is at the current HEAD (a train: PR branches skip first).
    const remote = mkdtempSync(join(tmpdir(), "lumen-vercel-ignore-remote-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", remote]);
      git("push", "-q", remote, "HEAD:refs/heads/verify/train");
      const head = git("rev-parse", "HEAD").trim();
      decide(["src/lib/head.ts"]); // a newer local commit; the remote still has `head`
      const newer = git("rev-parse", "HEAD").trim();
      const run = (sha: string, ref = "verify/train", remoteUrl = remote) => {
        try {
          execFileSync("bash", ["scripts/vercel-ignore.sh"], {
            cwd: repo,
            stdio: "ignore",
            env: cleanEnv({ VERCEL_GIT_COMMIT_REF: ref, VERCEL_GIT_COMMIT_SHA: sha, LUMEN_IGNORE_REMOTE: remoteUrl }),
          });
          return 0;
        } catch (e) {
          return (e as { status?: number }).status ?? -1;
        }
      };
      // The commit being built is not what the branch points at: skipped.
      expect(run(newer)).toBe(SKIP);
      // It is the head: the other rules decide (src/ changed: build).
      git("push", "-q", "-f", remote, "HEAD:refs/heads/verify/train");
      expect(run(newer)).toBe(BUILD);
      // No such branch, or no remote to ask: the other rules decide.
      expect(run(head, "verify/gone")).toBe(BUILD);
      expect(run(head, "verify/train", join(remote, "missing"))).toBe(BUILD);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("only main and the verify/* trains build; a PR branch is skipped unless LUMEN_BUILD_ALL=1", () => {
    decide(["src/lib/branch.ts"]); // an app change: the other rules would build it
    // No remote to ask, so the superseded rule stays out of the way.
    const run = (ref: string, extra: Record<string, string> = {}) => {
      try {
        execFileSync("bash", ["scripts/vercel-ignore.sh"], {
          cwd: repo,
          stdio: "ignore",
          env: cleanEnv({ VERCEL_GIT_COMMIT_REF: ref, VERCEL_GIT_COMMIT_SHA: "0".repeat(40), LUMEN_IGNORE_REMOTE: join(repo, "no-remote"), ...extra }),
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? -1;
      }
    };
    expect(run("feat/something")).toBe(SKIP);
    expect(run("fix/verify-later")).toBe(SKIP);
    expect(run("main")).toBe(BUILD);
    expect(run("verify/train")).toBe(BUILD);
    expect(run("verify/e2e-probe-1")).toBe(BUILD);
    expect(run("feat/something", { LUMEN_BUILD_ALL: "1" })).toBe(BUILD);
  });

  it("builds when there is no parent commit to diff against", () => {
    git("checkout", "-q", "--orphan", "solo");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "root", "--allow-empty");
    let code = 0;
    try {
      execFileSync("bash", ["scripts/vercel-ignore.sh"], { cwd: repo, stdio: "ignore", env: cleanEnv() });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).toBe(BUILD);
  });
});
