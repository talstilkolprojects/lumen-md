/**
 * Plan W8.6 — CODEOWNERS covers every sensitive file, found from the code
 * (scripts/lib/sensitivePaths.mjs), and `npm run pr:check` fails on a
 * sensitive file without an owner or a dated exception.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs module without type declarations
import { classify, coverage, inScope, MAX_EXCEPTION_DAYS, parseExceptions, suggestedLines } from "../../scripts/lib/sensitivePaths.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { parseCodeowners } from "../../scripts/lib/humanReview.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { treeCoverage } from "../../scripts/codeowners-coverage.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { parseArgs, runChecks } from "../../scripts/pr-check.mjs";

const ROOT = resolve(__dirname, "../..");
const TODAY = new Date("2026-11-14T12:00:00Z");

describe("which files are sensitive", () => {
  it("finds each kind from the path or the code", () => {
    expect(classify("src/sync/e2ee/kdf.ts", "export const n = 1;")).toEqual(["crypto"]);
    expect(classify("src/lib/vaultKey.ts", 'await crypto.subtle.deriveKey({ name: "PBKDF2" }, k, a, false, ["encrypt"]);')).toEqual(["crypto"]);
    expect(classify("src/storage/exportOdt.ts", "export const odt = 1;")).toEqual(["export"]);
    expect(classify("src/cli/convert.ts", "const md = await prepareForExport(doc);")).toEqual(["export"]);
    expect(classify("src/lib/markupSanitizer.ts", "")).toEqual(["sanitizer"]);
    expect(classify("src/epub/epub.ts", 'import DOMPurify from "dompurify";')).toEqual(["sanitizer"]);
    expect(classify("src/plugins/EmbedBlock.tsx", 'return <iframe sandbox="allow-scripts" src={u} />;')).toEqual(["frame"]);
    expect(classify("src/main.tsx", "guardFrames(document);")).toEqual(["frame"]);
    expect(classify("src/build/cspEndpoints.ts", "")).toEqual(["csp"]);
    expect(classify("index.html", '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">')).toEqual(["csp"]);
    expect(classify("src/ai/someProvider.ts", 'const r = await fetch("https://api.example.com/v1");')).toEqual(["network"]);
    expect(classify("src/plugins/useX.ts", "fetchWithRetry(url, {}, opts);")).toEqual(["network"]);
    expect(classify("src/collab/live.ts", "const ws = new WebSocket(url);")).toEqual(["network"]);
    expect(classify("src/ai/piiRedactor.ts", "")).toEqual(["redaction"]);
    expect(classify("src/renderer/criticMarkup.ts", "")).toEqual(["criticMarkup"]);
    expect(classify("src/renderer/pipeline.ts", "")).toEqual(["pipeline"]);
    expect(classify("src/plugins/X.tsx", "<div dangerouslySetInnerHTML={{ __html: h }} />")).toEqual(["pipeline"]);
    expect(classify("src/plugins/Y.tsx", "el.innerHTML = html;")).toEqual(["pipeline"]);
  });

  it("leaves out tests, tooling, docs, UI strings and code that only mentions a rule in a comment", () => {
    expect(inScope("src/__tests__/exportDocx.test.ts")).toBe(false);
    expect(inScope("src/storage/exportDocx.test.ts")).toBe(false);
    expect(inScope("e2e/export.spec.ts")).toBe(false);
    expect(inScope("docs/src/content/docs/export.md")).toBe(false);
    expect(inScope("scripts/translate-locale.mjs")).toBe(false);
    expect(inScope("src/ui/publishSiteDialogStrings.ts")).toBe(false);
    expect(inScope("src/help/generated/help.en.0.json")).toBe(false);
    expect(classify("src/lib/a.ts", "// we never call fetch() here\n/* new WebSocket( */\n * subtle.encrypt\nexport const a = 1;")).toEqual([]);
    expect(classify("src/lib/b.ts", "x.refetch(); cache.fetch(k); const ok = a.innerHTML === b;")).toEqual([]);
    // a digest is not a key: hashing for a cache id is not crypto here
    expect(classify("src/ai/responseCache.ts", 'await crypto.subtle.digest("SHA-256", data);')).toEqual([]);
  });
});

describe("the exceptions list", () => {
  const ex = (o: Record<string, unknown>[]) => parseExceptions(JSON.stringify(o), TODAY);
  it("needs a path, a reason and an expiry no more than the limit ahead", () => {
    expect(ex([{ path: "src/a.ts", reason: "owner joins next month, then listed", expires: "2026-12-31" }]).problems).toEqual([]);
    expect(ex([{ path: "src/a.ts", expires: "2026-12-31" }]).problems[0]).toMatch(/no reason/);
    expect(ex([{ path: "src/a.ts", reason: "owner joins next month, then listed" }]).problems[0]).toMatch(/no expiry/);
    expect(ex([{ path: "src/a.ts", reason: "owner joins next month, then listed", expires: "2026-02-30" }]).problems[0]).toMatch(/no expiry/);
    expect(ex([{ path: "src/a.ts", reason: "owner joins next month, then listed", expires: "2026-11-13" }]).problems[0]).toMatch(/expired on 2026-11-13/);
    expect(ex([{ path: "src/a.ts", reason: "owner joins next month, then listed", expires: "2027-06-01" }]).problems[0]).toMatch(new RegExp(`more than ${MAX_EXCEPTION_DAYS} days`));
    expect(ex([{ reason: "x".repeat(20), expires: "2026-12-01" }]).problems[0]).toMatch(/no path/);
    expect(parseExceptions("{", TODAY).problems[0]).toMatch(/not valid JSON/);
    expect(parseExceptions(null, TODAY).problems).toEqual([]);
  });

  it("an excepted file counts as covered until the exception expires; an unneeded one is reported", () => {
    const files = [{ path: "src/storage/exportOdt.ts", text: "" }, { path: "src/lib/plain.ts", text: "export {}" }];
    const ok = coverage(files, [], JSON.stringify([{ path: "src/storage/exportOdt.ts", reason: "moves under /src/storage/export/ in W9.1", expires: "2026-12-01" }, { path: "src/lib/plain.ts", reason: "left over from an old rename", expires: "2026-12-01" }]), TODAY);
    expect(ok.uncovered).toEqual([]);
    expect(ok.excepted.map((e: { file: string }) => e.file)).toEqual(["src/storage/exportOdt.ts"]);
    expect(ok.stale).toEqual(["src/lib/plain.ts"]);
    const late = coverage(files, [], JSON.stringify([{ path: "src/storage/exportOdt.ts", reason: "moves under /src/storage/export/ in W9.1", expires: "2026-11-01" }]), TODAY);
    expect(late.uncovered.map((u: { file: string }) => u.file)).toEqual(["src/storage/exportOdt.ts"]);
    expect(late.problems).toHaveLength(1);
  });
});

describe("coverage", () => {
  it("the last matching CODEOWNERS line decides, and a line with no owner un-owns", () => {
    const entries = parseCodeowners("/src/storage/ @talstilkol\n/src/storage/exportOdt.ts\n");
    const c = coverage([{ path: "src/storage/exportOdt.ts", text: "" }, { path: "src/storage/exportDocx.ts", text: "" }], entries, null, TODAY);
    expect(c.uncovered.map((u: { file: string }) => u.file)).toEqual(["src/storage/exportOdt.ts"]);
    expect(suggestedLines(c.uncovered)[0]).toMatch(/^\/src\/storage\/exportOdt\.ts\s+@talstilkol$/);
  });

  it("this repository: 0 sensitive files without an owner", () => {
    const paths = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
    const c = treeCoverage(ROOT, paths, new Date());
    expect(c).not.toBeNull();
    expect(c.sensitive.length).toBeGreaterThan(50);
    expect(c.uncovered).toEqual([]);
    expect(c.problems).toEqual([]);
  });
});

describe("pr:check", () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "lumen-owners-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    const put = (p: string, t: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.org");
    git("config", "user.name", "T");
    put(".github/CODEOWNERS", "/src/storage/exportDocx.ts @talstilkol\n");
    put("src/storage/exportDocx.ts", "export const docx = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base [skip ci]");
    const check = () => runChecks({ ...parseArgs(["--cwd", dir, "--base", "main", "--no-size"]), today: TODAY }).sections.find((s: { title: string }) => s.title === "Sensitive files have an owner");
    const commit = (m: string) => {
      git("add", "-A");
      git("commit", "-q", "-m", `${m} [skip ci]`);
    };
    return { dir, git, put, check, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("a new export file without an owner fails; an owner line or a dated exception passes; an expired one fails", () => {
    const r = repo();
    try {
      r.git("checkout", "-q", "-b", "pr");
      r.put("src/storage/exportOdt.ts", "export const odt = 1;\n");
      r.commit("feat: odt export");
      const bad = r.check();
      expect(bad.status).toBe("fail");
      expect(bad.lines.join("\n")).toContain("`src/storage/exportOdt.ts` (export)");
      expect(bad.lines.join("\n")).toMatch(/\/src\/storage\/exportOdt\.ts\s+@talstilkol/);

      r.put("security/codeowners-exceptions.json", JSON.stringify([{ path: "src/storage/exportOdt.ts", reason: "the second maintainer takes it in W9.1", expires: "2026-12-01" }]));
      r.commit("chore: exception");
      expect(r.check().status).toBe("ok");

      r.put("security/codeowners-exceptions.json", JSON.stringify([{ path: "src/storage/exportOdt.ts", reason: "the second maintainer takes it in W9.1", expires: "2026-11-01" }]));
      r.commit("chore: old exception");
      expect(r.check().status).toBe("fail");

      r.put(".github/CODEOWNERS", "/src/storage/exportDocx.ts @talstilkol\n/src/storage/exportOdt.ts @talstilkol\n");
      r.put("security/codeowners-exceptions.json", "[]\n");
      r.commit("chore: owner");
      const ok = r.check();
      expect(ok.status).toBe("ok");
      expect(ok.lines[0]).toMatch(/whole tree/);
    } finally {
      r.done();
    }
  });

  it("removing an owner line checks the whole tree and fails for the file left without one", () => {
    const r = repo();
    try {
      r.git("checkout", "-q", "-b", "pr");
      r.put(".github/CODEOWNERS", "# nobody\n");
      r.commit("chore: drop owner");
      const c = r.check();
      expect(c.status).toBe("fail");
      expect(c.lines.join("\n")).toContain("`src/storage/exportDocx.ts` (export)");
    } finally {
      r.done();
    }
  });

  it("a change to a file that is not sensitive passes; no CODEOWNERS skips", () => {
    const r = repo();
    try {
      r.git("checkout", "-q", "-b", "pr");
      r.put("src/lib/plain.ts", "export const a = 1;\n");
      r.commit("feat: plain");
      expect(r.check().status).toBe("ok");
      r.git("rm", "-q", ".github/CODEOWNERS");
      r.commit("chore: no owners");
      expect(r.check().status).toBe("skipped");
    } finally {
      r.done();
    }
  });
});
