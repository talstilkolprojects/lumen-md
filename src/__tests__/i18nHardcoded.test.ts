/**
 * The hard-coded UI strings gate (plan 9.1): what scripts/check-i18n-hardcoded.mjs
 * flags and what it leaves alone, and that src/ has none.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { scan, hasWords } from "../../scripts/check-i18n-hardcoded.mjs";

type Finding = { line: number; rule: string; text: string };
const check = (src: string, name = "x.tsx"): Finding[] => scan(name, src);
const rules = (src: string) => check(src).map((f) => f.rule);

describe("scripts/check-i18n-hardcoded", () => {
  it("flags JSX text, string children, visible props and UI sinks", () => {
    expect(rules(`const a = <button>Save changes</button>;`)).toEqual(["jsx-text"]);
    expect(rules(`const a = <p>{"Saved"}</p>;`)).toEqual(["jsx-string"]);
    expect(rules(`const a = <p>{ok ? "Saved" : "Failed"}</p>;`)).toEqual(["jsx-string", "jsx-string"]);
    expect(rules(`const a = <i aria-label="Close tab" />;`)).toEqual(["jsx-prop"]);
    expect(rules("const a = <i title={`Rename ${name}`} />;")).toEqual(["jsx-prop"]);
    expect(rules(`showAiToast("Token saved", "info");`)).toEqual(["ui-call"]);
    expect(rules(`await uiAlert({ message: "Push failed" });`)).toEqual(["ui-call"]);
    expect(rules(`window.alert("Done");`)).toEqual(["ui-call"]);
  });

  it("leaves translated text, code, symbols and names alone", () => {
    expect(check(`const a = <button title={t("x")}>{t("y")}</button>;`)).toEqual([]);
    expect(check(`showAiToast(t("toast.saved"), "info");`)).toEqual([]);
    expect(check(`const a = <span>· {n} / {m} ⌘K</span>;`)).toEqual([]);
    expect(check(`const a = <code>const x = "hello world";</code>;`)).toEqual([]);
    expect(check(`const a = <style>{".a { color: red }"}</style>;`)).toEqual([]);
    expect(check(`const a = <input placeholder="qwen2.5:7b" aria-label="JSON" />;`)).toEqual([]);
    expect(check(`const a = <div className="file tree" data-x="Hello there" />;`)).toEqual([]);
  });

  it("honours a justified i18n-allow comment", () => {
    expect(check(`// i18n-allow: example language code\nconst a = <input placeholder="ts code" />;`)).toEqual([]);
    expect(check(`const a = <input placeholder="ts code" />; // i18n-allow: example`)).toEqual([]);
  });

  it("counts only prose as words", () => {
    expect(hasWords("Close tab")).toBe(true);
    expect(hasWords("שלום")).toBe(true);
    expect(hasWords("Markdown · JSON")).toBe(false);
    expect(hasWords("VITE_SUPABASE_URL")).toBe(false);
    expect(hasWords("acme.com")).toBe(false);
    expect(hasWords("x")).toBe(false);
  });

  it("finds no hard-coded UI strings in src/ (the CI gate)", () => {
    const root = resolve(__dirname, "..", "..");
    const r = spawnSync(process.execPath, ["scripts/check-i18n-hardcoded.mjs"], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
});
