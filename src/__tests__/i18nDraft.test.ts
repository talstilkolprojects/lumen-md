/**
 * Plan 9.6 — translation drafts for new keys: `npm run i18n:draft`.
 *
 * Acceptance: 10 keys → 70 drafts (7 languages) in one command. The CLI
 * runs on a copy of the real locale tree with the fake engine (no model in
 * CI); the Ollama engine is checked against a fake server response.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCALES_DIR, ROOT, readLocale } from "../../scripts/lib/i18n-files.mjs";
import {
  DRAFT_LOCALES,
  acceptDraft,
  approve,
  draftMissing,
  fakeEngine,
  ollamaEngine,
  protect,
  readNeedsReview,
  sourceHash,
  unreviewed,
} from "../../scripts/lib/i18n-draft.mjs";

const SCRIPT = join(ROOT, "scripts", "i18n-draft.mjs");

describe("npm run i18n:draft (acceptance: 10 keys → 70 drafts)", () => {
  let dir = "";
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, `--locales=${join(dir, "locales")}`, `--review=${join(dir, "review")}`, ...args], { encoding: "utf8" });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lumen-i18n-draft-"));
    cpSync(LOCALES_DIR, join(dir, "locales"), { recursive: true });
    const file = join(dir, "locales", "en", "common.json");
    const en = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    for (let i = 0; i < 10; i++) en[`zzdraft.k${i}`] = i === 3 ? "Saved {n} notes in `vault/`" : `New string number ${i}`;
    const sorted = Object.fromEntries(Object.keys(en).sort().map((k) => [k, en[k]]));
    writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("drafts the 10 new keys in all 7 languages in one command", () => {
    const out = run("--engine=fake");
    expect(out).toContain("70 draft(s) written");
    for (const lang of DRAFT_LOCALES) {
      const data = readLocale(lang, join(dir, "locales"));
      for (let i = 0; i < 10; i++) expect(data[`zzdraft.k${i}`], `${lang} k${i}`).toMatch(new RegExp(`^\\[${lang}\\] `));
      // Placeholders and inline code survive.
      expect(data["zzdraft.k3"]).toBe(`[${lang}] Saved {n} notes in \`vault/\``);
    }
  });

  it("lists every draft as needs-review, per domain file", () => {
    const review = readNeedsReview(join(dir, "review"));
    expect(Object.keys(review)).toHaveLength(10);
    expect(Object.values(review).flatMap((langs) => Object.keys(langs))).toHaveLength(70);
    expect(review["zzdraft.k3"].he).toBe(sourceHash("Saved {n} notes in `vault/`"));
    expect(readFileSync(join(dir, "review", "common.json"), "utf8")).toContain('"zzdraft.k0"');
  });

  it("drafts nothing twice; approval clears one language", () => {
    expect(run("--engine=fake")).toContain("0 draft(s) written");
    expect(run("--approve=he")).toContain("10 he draft(s) approved");
    const review = readNeedsReview(join(dir, "review"));
    const en = readLocale("en", join(dir, "locales"));
    expect(unreviewed("he", en, review)).toEqual([]);
    expect(unreviewed("fr", en, review)).toHaveLength(10);
    expect(run("--list")).toContain("60 draft(s) need review");
  });
});

describe("draft rules", () => {
  it("protects placeholders and code, and rejects a draft that changes them", () => {
    const p = protect("Saved {n} notes in `vault/` · {{words}}");
    expect(p.masked).toBe("Saved ⟦0⟧ notes in ⟦1⟧ · ⟦2⟧");
    expect(p.restore("נשמרו ⟦0⟧ פתקים ב-⟦1⟧ · ⟦2⟧")).toBe("נשמרו {n} פתקים ב-`vault/` · {{words}}");
    expect(p.restore("נשמרו פתקים ב-⟦1⟧ · ⟦2⟧")).toBeNull();
    expect(p.restore("⟦0⟧ ⟦0⟧ ⟦1⟧ ⟦2⟧")).toBeNull();
    expect(acceptDraft("{n} files", "{count} קבצים")).toBeNull();
    expect(acceptDraft("{n} files", "")).toBeNull();
    expect(acceptDraft("{n} files", "{n} קבצים")).toBe("{n} קבצים");
  });

  it("a rejected or failed draft is not written and not listed", async () => {
    const en = { "a.one": "{n} items", "a.two": "Two" };
    const broken = { id: "broken", translate: async (texts: string[]) => texts.map(() => "no tokens") };
    const r = await draftMissing({ en, locales: { he: {} }, engine: broken });
    expect(r.drafts).toEqual({ he: { "a.two": "no tokens" } });
    expect(r.rejected).toEqual([{ lang: "he", key: "a.one", reason: "placeholders or code changed" }]);
    expect(Object.keys(r.review)).toEqual(["a.two"]);

    const down = { id: "down", translate: async () => Promise.reject(new Error("offline")) };
    const r2 = await draftMissing({ en, locales: { he: {} }, engine: down });
    expect(r2.drafts).toEqual({});
    expect(r2.rejected.map((x) => x.reason)).toEqual(["engine: offline", "engine: offline"]);
  });

  it("only the asked keys, only where missing", async () => {
    const en = { "a.one": "One", "a.two": "Two", "a.three": "Three" };
    const r = await draftMissing({ en, locales: { he: { "a.one": "אחת" }, fr: {} }, engine: fakeEngine(), keys: ["a.one", "a.two"] });
    expect(r.drafts).toEqual({ fr: { "a.one": "[fr] One", "a.two": "[fr] Two" }, he: { "a.two": "[he] Two" } });
    expect(approve(r.review, "fr", ["a.one"])).toBe(1);
    expect(r.review).toEqual({ "a.two": { fr: sourceHash("Two"), he: sourceHash("Two") } });
  });

  it("the Ollama engine sends one JSON request per language and reads the array back", async () => {
    const calls: Array<{ url: string; body: { model: string; format: string; messages: Array<{ content: string }> } }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ t: ["שמור", "נשמרו ⟦0⟧"] }) } }) };
    }) as unknown as typeof fetch;
    const engine = ollamaEngine({ host: "http://127.0.0.1:11434/", model: "qwen2.5:7b", fetchImpl });
    const r = await draftMissing({ en: { "x.save": "Save", "x.saved": "Saved {n}" }, locales: { he: {} }, engine });
    expect(r.drafts.he).toEqual({ "x.save": "שמור", "x.saved": "נשמרו {n}" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0].body.format).toBe("json");
    expect(JSON.parse(calls[0].body.messages[1].content)).toEqual(["Save", "Saved ⟦0⟧"]);
  });
});
