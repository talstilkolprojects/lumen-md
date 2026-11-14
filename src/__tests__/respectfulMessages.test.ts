/**
 * Plan W3.2 — the three gates: no raw error text on screen, an action in
 * every empty state, and a confirmation or an undo for every destructive
 * action (checked command by command).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs scripts without type declarations
import { scan as scanRaw } from "../../scripts/check-raw-errors.mjs";
// @ts-expect-error — plain .mjs scripts without type declarations
import { scan as scanEmpty } from "../../scripts/check-empty-states.mjs";
// @ts-expect-error — plain .mjs scripts without type declarations
import { scan as scanDestructive, scanAll } from "../../scripts/check-destructive.mjs";

const ROOT = resolve(__dirname, "..", "..");
const gate = (script: string) => spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8" });

type Finding = { line: number; rule?: string; key?: string; api?: string; problem?: string; command?: string };

describe("raw error messages (scripts/check-raw-errors)", () => {
  const rules = (src: string) => (scanRaw("x.tsx", src) as Finding[]).map((f) => f.rule);

  it("flags a caught error's text in t(), toasts, dialogs, setters and JSX", () => {
    expect(rules(`try {} catch (e) { showAiToast(t("x.failed", { error: (e as Error).message }), "error"); }`)).toEqual(["ui-call"]);
    expect(rules(`try {} catch (e) { await uiAlert({ message: String(e) }); }`)).toEqual(["ui-call"]);
    expect(rules(`try {} catch (err) { toast.error(t("x"), err instanceof Error ? err.message : String(err)); }`)).toEqual(["ui-call"]);
    expect(rules(`try {} catch (e) { setError((e as Error).message); }`)).toEqual(["ui-state"]);
    expect(rules(`p.catch((e) => setStatus(\`\${e}\`));`)).toEqual(["ui-state"]);
    expect(rules(`function A() { try {} catch (e) { return <p>{(e as Error).stack}</p>; } }`)).toEqual(["jsx"]);
  });

  it("leaves explainError, predicates, reads and logs alone", () => {
    expect(rules(`try {} catch (e) { showAiToast(t("x.failed", { error: explainError(e) }), "error"); }`)).toEqual([]);
    expect(rules(`try {} catch (e) { showAiToast(t(isQuotaError(e) ? "a" : "b"), "error"); }`)).toEqual([]);
    expect(rules(`try {} catch (e) { if (e instanceof AiError && e.code === "NO_KEY") showAiToast(t("k"), "error"); }`)).toEqual([]);
    expect(rules(`try {} catch (e) { log.warn("x", (e as Error).message); }`)).toEqual([]);
    expect(rules(`try {} catch (e) { showAiToast(String(e)); } // raw-error-allow: the user's own code's error`)).toEqual([]);
  });

  it("finds none in src/ (the CI gate)", () => {
    const r = gate("scripts/check-raw-errors.mjs");
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("empty states (scripts/check-empty-states)", () => {
  const keys = (src: string) => (scanEmpty("x.tsx", src).findings as Finding[]).map((f) => f.key);

  it("an empty-state string rendered outside <EmptyState> is a finding", () => {
    expect(keys(`const a = <p>{t("trash.empty")}</p>;`)).toEqual(["trash.empty"]);
    expect(keys(`const a = <div>{x ? t("a") : t("search.noMatches")}</div>;`)).toEqual(["search.noMatches"]);
  });

  it("<EmptyState message action>, a named adjacent action, or a non-empty-state mark pass; toasts are not empty states", () => {
    expect(keys(`const a = <EmptyState message={t("trash.empty")} action={{ label: t("x"), onClick }} />;`)).toEqual([]);
    expect(keys(`const a = (\n  // empty-action: the Add button below\n  <p>{t("keys.empty")}</p>\n);`)).toEqual([]);
    expect(keys(`const a = <span>{/* empty-allow: a cell value */}{t("db.none")}</span>;`)).toEqual([]);
    expect(keys(`showAiToast(t("clip.empty"), "info");`)).toEqual([]);
  });

  it("every empty state in src/ has an action (100%)", () => {
    const r = gate("scripts/check-empty-states.mjs");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/✓ empty states: (\d+) with an action/);
    expect(Number(/✓ empty states: (\d+)/.exec(r.stderr)![1])).toBeGreaterThanOrEqual(19);
  });
});

describe("destructive actions (scripts/check-destructive)", () => {
  const problems = (src: string) => (scanDestructive("x.tsx", src).findings as Finding[]).map((f) => f.problem);

  it("a destructive call needs a confirmation or an undo, and a command declares which", () => {
    expect(problems(`const f = async () => { await emptyTrash(); };`)).toEqual(["neither asks nor offers an undo"]);
    expect(problems(`const f = async () => { if (!(await uiConfirm({ message: t("x") }))) return; await emptyTrash(); };`)).toEqual([]);
    expect(problems(`const f = async () => { const items = await trashPaths(p); toast(t("x"), { action: { label: t("tree.undo"), run: () => undoTrash(items) } }); };`)).toEqual([]);
    expect(problems(`const c = { id: "x.clear", action: async () => { if (await uiConfirm({ message: m })) clearTrace(); } };`)).toEqual(['the command must declare destructive: "confirm"']);
    expect(problems(`const c = { id: "x.clear", destructive: "confirm", action: async () => { if (await uiConfirm({ message: m })) clearTrace(); } };`)).toEqual([]);
  });

  it("each destructive command, one by one: declared, and doing what it declares", () => {
    const { actions } = scanAll() as { actions: { command?: string; declared?: string; how: string; api: string }[] };
    const commands = Object.fromEntries(actions.filter((a) => a.command).map((a) => [a.command, `${a.declared}/${a.how}`]));
    // ai.styleProfile (aiActions.ts, train 4) and spell.hebrewDictionary (toolsActions.ts, train 5) load
    // their bodies on use, like tools.vaultDoctorFix: checked declaration and body together below.
    expect(commands).toEqual({
      "git.pull": "confirm/confirm",
    });
  });

  it.each([
    ["ai.styleProfile", "ai.ts", "aiActions", "aiStyleProfile", "export const aiStyleProfile", "sp.clearStyleProfile("],
    ["spell.hebrewDictionary", "tools.ts", "toolsActions", "toggleHebrewDictionary", "export const toggleHebrewDictionary", "svc.removeHebrewDictionary("],
  ])("%s: its body is loaded on use, the command declares it, and the loaded body asks before it deletes", (id, domain, module, fn, start, destroy) => {
    const commands = readFileSync(resolve(ROOT, `src/commands/domains/${domain}`), "utf8");
    expect(commands).toMatch(new RegExp(`id: "${id.replace(".", "\\.")}",\\s*destructive: "confirm",[\\s\\S]*?${module}"\\)\\.then\\(\\(m\\) => m\\.${fn}\\(\\)\\)`));
    const body = readFileSync(resolve(ROOT, `src/commands/domains/${module}.ts`), "utf8");
    const own = body.slice(body.indexOf(start));
    const del = own.indexOf(destroy);
    const ask = own.lastIndexOf("uiConfirm(", del);
    expect(del).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(del);
  });

  it("a command whose body is loaded on use declares it, and the loaded body asks (tools.vaultDoctorFix)", () => {
    // The vault commands load their bodies lazily (vaultDoctorActions.ts), so the scanner sees the
    // destructive write there, not inside the command: check the declaration and the body together.
    const commands = readFileSync(resolve(ROOT, "src/commands/domains/vault.ts"), "utf8");
    expect(commands).toMatch(/id: "tools\.vaultDoctorFix",\s*destructive: "confirm",[\s\S]*?vaultDoctorActions"\)\)\.fixDoctorLinks\(\)/);
    const body = readFileSync(resolve(ROOT, "src/commands/domains/vaultDoctorActions.ts"), "utf8");
    const fix = body.slice(body.indexOf("export async function fixDoctorLinks"));
    const ask = fix.indexOf("uiConfirm(");
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(fix.indexOf("writeWorkspaceFile"));
  });

  it("every destructive action in src/ asks first or can be undone (the CI gate)", () => {
    const r = gate("scripts/check-destructive.mjs");
    expect(r.status, r.stderr).toBe(0);
  });
});
