/**
 * Plan W10.B10 (audit W7.5): "Ask the law" no longer calls a quote checked
 * against itself "verified". askTheLaw returns quotes (verified: false,
 * always). An answer is verified only by the critic in
 * src/sources/knesset/answer.ts, and an answer that contradicts the section
 * is never verified.
 *
 * The laws are the test fixtures in fixtures/knesset/askTheLaw.json
 * (excerpts, see its SOURCES.md). The model is a stand-in for the chat call
 * only (there is no model offline). The search, the quote, the critic's
 * number check and the verdict logic are the real code.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { askTheLaw, parseLawNote, renderLawNote, type SavedLaw } from "../sources/knesset/store";
import { rowsOf, toLaw, type Law } from "../sources/knesset/odata";
import { answerLawQuestion, criticCheck, numbersNotInSection, type LawChat } from "../sources/knesset/answer";

const FIX = join(__dirname, "fixtures/knesset");
const ASK: { laws: Record<string, string>; questions: Array<{ q: string; law: string; section: string }> } = JSON.parse(readFileSync(join(FIX, "askTheLaw.json"), "utf8"));
const LAWS: Law[] = rowsOf(JSON.parse(readFileSync(join(FIX, "laws.v4.json"), "utf8"))).map(toLaw).filter((l): l is Law => l !== null);

const saved: SavedLaw[] = Object.entries(ASK.laws).map(([name, text]) => {
  const law = LAWS.find((l) => l.name === name)!;
  return parseLawNote(`Sources/Knesset/Laws/${name}.md`, renderLawNote(law, "2026-11-15", text))!;
});

const FOI_QUESTION = "איך מגישים בקשה לקבלת מידע?";
const foiQuote = () => askTheLaw(FOI_QUESTION, saved, 1)[0];

/** A model stand-in: the first call writes the answer, the second is the critic. */
function model(answer: string, verdict: string): { chat: LawChat; calls: string[] } {
  const calls: string[] = [];
  const chat: LawChat = async (messages) => {
    calls.push(messages[0].content);
    return calls.length === 1 ? answer : verdict;
  };
  return { chat, calls };
}

describe("Ask the law: quotes are not verified answers (W10.B10)", () => {
  it("every result is a quote with verified: false, for all 20 golden questions", () => {
    for (const g of ASK.questions) {
      for (const a of askTheLaw(g.q, saved, 3)) {
        expect(a.kind).toBe("quote");
        expect(a.verified).toBe(false);
      }
    }
  });

  it("the golden question finds the right section", () => {
    const a = foiQuote();
    expect(a.law.law.name).toBe('חוק חופש המידע, התשנ"ח-1998');
    expect(a.section.number).toBe("7");
    expect(a.quoteInLaw).toBe(true);
  });

  it("without a model there is no critic and no answer, so nothing is verified", async () => {
    expect(await answerLawQuestion(FOI_QUESTION, foiQuote(), null)).toBeNull();
    expect(await criticCheck("בקשה תוגש בכתב.", "7. (א) בקשה לקבלת מידע תוגש בכתב", null)).toBe("no-critic");
  });

  it("an answer that contradicts the section is not verified, even when the model calls it supported", async () => {
    // Section 7 says in writing and gives no deadline; the answer invents one.
    const m = model("אפשר להגיש בקשה בעל פה, והרשות תענה בתוך 30 ימים.", "SUPPORTED");
    const r = await answerLawQuestion(FOI_QUESTION, foiQuote(), m.chat);
    expect(r).toMatchObject({ kind: "answer", critic: "contradicted", verified: false });
    expect(numbersNotInSection(r!.claim, foiQuote().section.text)).toEqual(["30"]);
  });

  it("the critic's own CONTRADICTED or NOT_ENOUGH is not verified; a failing critic is not verified", async () => {
    expect((await answerLawQuestion(FOI_QUESTION, foiQuote(), model("אפשר להגיש בקשה בעל פה.", "CONTRADICTED").chat))?.verified).toBe(false);
    expect((await answerLawQuestion(FOI_QUESTION, foiQuote(), model("מגישים בקשה.", "NOT_ENOUGH").chat))?.verified).toBe(false);
    let n = 0;
    const flaky: LawChat = async () => {
      if (n++ === 0) return "בקשה תוגש בכתב.";
      throw new Error("model gone");
    };
    expect(await answerLawQuestion(FOI_QUESTION, foiQuote(), flaky)).toMatchObject({ critic: "unsupported", verified: false });
  });

  it("only the critic's SUPPORTED, with no number the section lacks, verifies an answer", async () => {
    const m = model("בקשה לקבלת מידע תוגש בכתב, והמבקש לא צריך לנמק אותה.", "SUPPORTED");
    const r = await answerLawQuestion(FOI_QUESTION, foiQuote(), m.chat);
    expect(r).toMatchObject({ critic: "supported", verified: true });
    // The critic was asked separately, with the section's text.
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]).toMatch(/SUPPORTED .* CONTRADICTED .* NOT_ENOUGH/);
  });

  it("no code path in the Knesset source sets verified: true by itself", () => {
    const dir = join(__dirname, "..", "sources", "knesset");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/verified:\s*true/);
    }
    expect(readFileSync(join(dir, "answer.ts"), "utf8")).toContain('verified: critic === "supported"');
  });
});
