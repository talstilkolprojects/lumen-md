/**
 * Plan 9.4 — the translation review agent (scripts/i18n-review.mjs): its
 * checks, and the acceptance: 0 missing (or extra) variables in any of the
 * seven locales.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
// @ts-expect-error the review agent is plain JavaScript
import { checkPair, chrF, placeholders, review, formatReport, LOCALES } from "../../scripts/i18n-review.mjs";

const ROOT = join(__dirname, "../..");

type Finding = { locale: string; key: string; kind: string; level: string; detail: string };

describe("translation review checks", () => {
  it("finds a missing or extra placeholder, in both brace styles", () => {
    expect(placeholders("Saved {count} of {{total}}")).toEqual(["count", "total"]);
    const kinds = (tr: string) => (checkPair("de", "k", "Cloned into \"{folder}/\" — {count} files.", tr) as Finding[]).map((f) => `${f.kind}${f.detail}`);
    expect(kinds("Cloned into \\")).toContain("missing-var{folder}");
    expect(kinds("Geklont nach „{folder}/“ — {count} Dateien.")).toEqual([]);
    expect(kinds("Geklont nach „{ordner}/“ — {count} Dateien.")).toEqual(["missing-var{folder}", "extra-var{ordner}"]);
  });

  it("flags an abnormal length and an untranslated string, but not a product name", () => {
    expect((checkPair("fr", "k", "Join the collaborative session now, please", "Rejoindre") as Finding[]).map((f) => f.kind)).toEqual(["length"]);
    expect((checkPair("fr", "k", "Reply to this comment…", "Reply to this comment…") as Finding[]).map((f) => f.kind)).toEqual(["untranslated"]);
    expect(checkPair("fr", "k", "Markdown / LaTeX", "Markdown / LaTeX")).toEqual([]);
    expect((checkPair("he", "k", "Hello", undefined) as Finding[])[0].kind).toBe("missing-key");
    // CJK is shorter: a fifth of the English is normal there.
    expect(checkPair("ja", "k", "Delete file \"{path}\"? This cannot be undone.", "ファイル「{path}」を削除しますか？元に戻せません。")).toEqual([]);
  });

  it("chrF scores a close back-translation high and an unrelated one low", () => {
    expect(chrF("Delete the file? This cannot be undone.", "Delete file? This cannot be undone.")).toBeGreaterThan(70);
    expect(chrF("The weather is nice today", "Delete file? This cannot be undone.")).toBeLessThan(25);
  });

  it("back-translation: a translation that reads back as something else is a deviation", async () => {
    const back = async (_locale: string, texts: string[]) => texts.map(() => "The weather is nice today");
    const { findings } = (await review(ROOT, { back, sample: 3 })) as { findings: Finding[] };
    expect(findings.filter((f) => f.kind === "deviation").length).toBeGreaterThan(0);
  });
});

describe("the seven locales (acceptance: 0 missing variables)", () => {
  it("every placeholder of the English is in every translation, and no other", async () => {
    const result = (await review(ROOT)) as { findings: Finding[]; stats: Record<string, unknown> };
    const errors = result.findings.filter((f) => f.level === "error").map((f) => `${f.locale} ${f.key} ${f.kind} ${f.detail}`);
    expect(LOCALES).toHaveLength(7);
    expect(errors).toEqual([]);
    expect(formatReport(result)).toContain("Missing variables: **0** · extra variables: **0**");
  });
});
