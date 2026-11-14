/**
 * Plan 11.1 — every stored key and every persisted store field is in
 * `src/settings/schema.ts`.
 *
 * The sources are scanned for:
 *   (a) `lumen.<…>` string literals (the naming rule for storage keys);
 *   (b) the literal key of a `localStorage` / `sessionStorage` call;
 *   (c) a `const X = "…"` key passed by name to such a call;
 *   (d) the name of a persisted zustand store, and the fields its
 *       `partialize` returns.
 * A template part (`${provider}`) reads as `*`. A new key that isn't in the
 * schema fails here, so the settings screen and its export never miss one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { SETTINGS, SETTINGS_TABS, entryForAppField, entryForLocalKey, matchesEntry } from "../settings/schema";
import { t } from "../i18n";
import { lazyEnglish } from "./helpers/i18nLazy";

const ROOT = resolve(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** Literals that look like keys but are not stored under that name. */
const NOT_KEYS: Record<string, string> = {
  "lumen.": "prefix that clearLumenState matches on",
  "lumen.collab.v1": "PBKDF2 salt text, not a key",
  "lumen.word-count": "built-in plugin id",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|eval)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Drop comment lines: doc comments mention keys in prose and examples. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

const star = (s: string) => s.replace(/\$\{[^}]*\}/g, "*");

function storedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (key: string, file: string) => {
    if (!found.has(key)) found.set(key, relative(ROOT, file));
  };
  for (const file of sourceFiles(SRC)) {
    const src = code(file);
    for (const m of src.matchAll(/["'`](lumen\.[A-Za-z0-9_.-]*(?:\$\{[^}`]*\}[A-Za-z0-9_.-]*)*)["'`]/g)) add(star(m[1]), file);
    for (const m of src.matchAll(/(?:localStorage|sessionStorage)\??\.(?:getItem|setItem|removeItem)\(\s*["'`]([^"'`]+)["'`]/g)) add(star(m[1]), file);
    const consts = new Map<string, string>();
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`]+)["'`]/g)) consts.set(m[1], m[2]);
    for (const m of src.matchAll(/(?:localStorage|sessionStorage)\??\.(?:getItem|setItem|removeItem)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
      const value = consts.get(m[1]);
      if (value) add(star(value), file);
    }
    // A zustand `persist` store: `name: "…",` before `partialize` in the same options object
    // (comments and a `storage:` option may stand between them, as in useStore.ts since plan 8.4).
    // Since W3.9 the storage option holds nested braces ({ storage: () => … }): two levels are allowed.
    for (const m of src.matchAll(/\bname:\s*["'`]([^"'`]+)["'`],(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\bpartialize:/g)) add(m[1], file);
  }
  return found;
}

function persistedFields(): string[] {
  const src = readFileSync(join(SRC, "store", "useStore.ts"), "utf8");
  // `partialize: partializeAppState` names a function defined above the store (plan 8.4).
  const named = /const partializeAppState = \(s: AppState\) =>\s*\(\{([\s\S]*?)\n {2}\}\);/.exec(src);
  if (named) {
    // Top-level fields (`name: s.name,` or `name: {`), and those of the branch spread in
    // when the vault is not encrypted (`...(encrypted ? {} : { doc: {…}, openTabs })`).
    return [...named[1].matchAll(/^(?: {4}| {10})(\w+):/gm)].map((m) => m[1]);
  }
  const block = /partialize:\s*\(s\)\s*=>\s*\(\{([\s\S]*?)\n\s{6}\}\),/.exec(src);
  if (!block) throw new Error("partialize not found in useStore.ts");
  // Top-level fields only: `name: s.name,` or `name: {` (an object built inline).
  return [...block[1].matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);
}

describe("settings schema (plan 11.1)", () => {
  it("finds the keys it is meant to find (the scan itself works)", () => {
    const keys = storedKeys();
    for (const k of ["lumen.ai.policy", "lumen-sidebar-width", "lumen.ai.key.*", "lumen.collab.wsToken", "lumen-md"]) {
      expect(keys.has(k), k).toBe(true);
    }
    expect(persistedFields()).toEqual(expect.arrayContaining(["mode", "theme", "locale", "doc", "openTabs"]));
  });

  it("holds 100% of the stored keys", () => {
    const missing = [...storedKeys()]
      .filter(([key]) => !(key in NOT_KEYS) && !entryForLocalKey(key))
      .map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it("holds 100% of the persisted store fields", () => {
    const fields = persistedFields();
    expect(fields.length).toBeGreaterThan(20);
    expect(fields.filter((f) => !entryForAppField(f))).toEqual([]);
  });

  it("has no entry that matches nothing in the sources (no stale keys)", () => {
    const keys = [...storedKeys().keys()];
    const fields = persistedFields();
    const stale = SETTINGS.filter((e) =>
      e.store === "app" ? !fields.includes(e.id) : !keys.some((k) => k === e.id || matchesEntry(e, k)),
    ).map((e) => e.id);
    expect(stale).toEqual([]);
  });

  it("lists each id once", () => {
    const ids = SETTINGS.map((e) => `${e.store}:${e.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never lets a secret be a setting, and gives every shown entry a real label", () => {
    // A label may live in a lazily loaded domain (src/i18n/lazy/*.json, e.g. fineTune.json): real too.
    const lazy = lazyEnglish();
    const real = (k: string) => t(k) !== k || typeof lazy[k] === "string";
    for (const e of SETTINGS) {
      if (/\.(key|token|refresh|password|pkce)\b|searchKey|wsToken/.test(e.id)) expect(e.kind, e.id).toBe("secret");
      if (e.label) expect(real(e.label), e.label).toBe(true);
      for (const o of e.options ?? []) if (o.label) expect(real(o.label), o.label).toBe(true);
      if (e.kind === "setting") expect(e.type, e.id).toBeDefined();
    }
    for (const tab of SETTINGS_TABS) expect(real(tab.label), tab.label).toBe(true);
  });
});
