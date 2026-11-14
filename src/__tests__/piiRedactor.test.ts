/**
 * Plan 2.6: the redactor (src/ai/pii.ts) and its place on the cloud path
 * (src/ai/llm.ts → src/ai/piiRedactor.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = { aiKey: "sk-test" as string | null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => state } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
const ollamaChat = vi.fn(async (_m: unknown) => "from ollama");
vi.mock("../ai/ollamaProvider", () => ({
  isOllamaAvailable: async () => ollama.up,
  chatOllama: (m: unknown) => ollamaChat(m),
  chatOllamaStream: async function* () {
    yield "x";
  },
  getBaseUrl: () => "http://127.0.0.1:11434",
  ollamaKnownAvailable: () => ollama.up,
}));
const ollama = vi.hoisted(() => ({ up: false }));
const claude = vi.hoisted(() => ({ seen: [] as unknown[], answer: "" }));
vi.mock("../ai/anthropicProvider", () => ({
  chatAnthropic: async (m: unknown) => {
    claude.seen.push(m);
    return claude.answer;
  },
  chatAnthropicStream: async function* (m: unknown) {
    claude.seen.push(m);
    // A token split across chunks.
    for (const piece of claude.answer.match(/.{1,3}/gsu) ?? []) yield piece;
  },
}));

import { PiiVault, alignNer, applyRedaction, findPatterns, findPii, ibanValid, luhnValid, redactText, validIsraeliId } from "../ai/pii";
import { __setNer, __setPreview, redactionLog, redactionTotals, setPreviewEnabled, setRedactionEnabled } from "../ai/piiRedactor";
import { chat, chatStream } from "../ai/llm";

const types = (text: string) => findPatterns(text).map((s) => `${s.type}:${s.text}`);

describe("patterns (2.6.1)", () => {
  it("validators: ת״ז check digit, Luhn, IBAN mod 97", () => {
    expect(validIsraeliId("832095053")).toBe(true);
    expect(validIsraeliId("832095054")).toBe(false);
    expect(luhnValid("4580 4717 7972 5830")).toBe(true);
    expect(luhnValid("4580 4717 7972 5831")).toBe(false);
    expect(ibanValid("IL68 0120 3807 3045 3120 794")).toBe(true);
    expect(ibanValid("IL69 0120 3807 3045 3120 794")).toBe(false);
  });

  it("finds each type in Hebrew and English text, with Hebrew prefixes", () => {
    expect(types("אפשר לחזור אליי ב-054-1471258 או ל-dana.k@example.com")).toEqual(["PHONE:054-1471258", "EMAIL:dana.k@example.com"]);
    expect(types("Call +972 3 555 1234 or 0541471258.")).toEqual(["PHONE:+972 3 555 1234", "PHONE:0541471258"]);
    expect(types("ת״ז 832095053, כרטיס 4580 4717 7972 5830")).toEqual(["IL_ID:832095053", "CREDIT_CARD:4580 4717 7972 5830"]);
    expect(types("לחשבון IL68 0120 3807 3045 3120 794 של כרמית")).toEqual(["IBAN:IL68 0120 3807 3045 3120 794"]);
    expect(types("מספר רישוי 649-75-502 ו-12-345-67")).toEqual(["LICENSE_PLATE:649-75-502", "LICENSE_PLATE:12-345-67"]);
    expect(types("תאריך לידה — 18.11.1983")).toEqual(["DATE_OF_BIRTH:18.11.1983"]);
    expect(types("She was born on March 3, 1990.")).toEqual(["DATE_OF_BIRTH:March 3, 1990"]);
  });

  it("leaves the look-alikes alone: invalid ID / card, order, tracking and product numbers, public dates", () => {
    for (const text of [
      "בטופס הופיע המספר 832095054, אבל ספרת הביקורת שלו שגויה.",
      "המספר 4580 4717 7972 5831 נדחה: הוא לא עובר את בדיקת Luhn.",
      "מספר ההזמנה שלך הוא 983266193; שמור אותו לבירורים.",
      "מספר המעקב של החבילה הוא RR117037094IL.",
      "הקוד של המוצר במחסן הוא 055-5631464, והמלאי יתעדכן.",
      "14 במאי 1948 הוא תאריך שכל תלמיד לומד.",
      "הכנס נערך ב-7.11.2021, ואלפי משתתפים הגיעו.",
      "version 1.2.3 of build 2026-10-24",
    ])
      expect(types(text), text).toEqual([]);
  });
});

describe("tokens and restore (2.6.3)", () => {
  it("one value, one token, across messages; restored in the answer; unknown tokens stay", async () => {
    const v = new PiiVault();
    const a = await redactText("כתבו ל-noa@example.com או ל-noa@example.com", v);
    const b = await redactText("ושוב noa@example.com, וגם 054-1471258", v);
    expect(a).toBe("כתבו ל-⟨EMAIL_1⟩ או ל-⟨EMAIL_1⟩");
    expect(b).toBe("ושוב ⟨EMAIL_1⟩, וגם ⟨PHONE_1⟩");
    expect(v.counts).toEqual({ EMAIL: 1, PHONE: 1 });
    expect(v.restore("שלחתי ל-⟨EMAIL_1⟩ והתקשרתי ל-⟨PHONE_1⟩ ול-⟨PHONE_9⟩")).toBe("שלחתי ל-noa@example.com והתקשרתי ל-054-1471258 ול-⟨PHONE_9⟩");
  });

  it("a stream restores a token split across chunks", async () => {
    const v = new PiiVault();
    applyRedaction("x@example.org", [{ start: 0, end: 13, type: "EMAIL", text: "x@example.org" }], v);
    async function* chunks() {
      yield "to ⟨EM";
      yield "AIL_";
      yield "1⟩ now ⟨";
    }
    let out = "";
    for await (const c of v.restoreStream(chunks())) out += c;
    expect(out).toBe("to x@example.org now ⟨");
  });

  it("names come from the NER and never overlap a pattern", async () => {
    const spans = await findPii("דנה כהן, ת״ז 832095053", { ner: async () => [{ start: 0, end: 7, type: "PERSON" }, { start: 13, end: 22, type: "PERSON" }] });
    expect(spans.map((s) => `${s.type}:${s.text}`)).toEqual(["PERSON:דנה כהן", "IL_ID:832095053"]);
    // A failing model: patterns only.
    expect((await findPii("ת״ז 832095053", { ner: async () => Promise.reject(new Error("x")) })).length).toBe(1);
  });

  it("alignNer merges B-/I- and WordPiece pieces into character spans", () => {
    const text = "פגשתי את דנה כהן בחיפה";
    const spans = alignNer(text, [
      { entity: "B-PER", word: "דנה", score: 0.99 },
      { entity: "I-PER", word: "כה", score: 0.98 },
      { entity: "I-PER", word: "##ן", score: 0.97 },
      { entity: "B-GPE", word: "חיפה", score: 0.95 },
    ]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["דנה כהן"]);
  });
});

describe("on the cloud path (2.6.1, 2.6.4)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "cloud");
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "sk-ant-test");
    localStorage.setItem("lumen.ai.cache", "off");
    claude.seen.length = 0;
    claude.answer = "";
    ollama.up = false;
    ollamaChat.mockClear();
    __setNer(null);
    __setPreview(null);
  });

  const MSG = [{ role: "user" as const, content: "סכם: דנה (ת״ז 832095053) ביקשה שנחזור אליה ב-054-1471258 או ל-dana@example.com." }];

  it("the provider sees tokens only; the answer comes back with the originals; the log counts, never values", async () => {
    claude.answer = "נחזור אל ⟨PHONE_1⟩ ונכתוב ל-⟨EMAIL_1⟩.";
    const before = redactionTotals().items;
    const out = await chat(MSG);
    const sent = JSON.stringify(claude.seen[0]);
    for (const v of ["832095053", "054-1471258", "dana@example.com"]) expect(sent).not.toContain(v);
    expect(sent).toContain("⟨IL_ID_1⟩");
    expect(out).toBe("נחזור אל 054-1471258 ונכתוב ל-dana@example.com.");
    expect(redactionTotals().items - before).toBe(3);
    expect(JSON.stringify(redactionLog().at(-1))).not.toContain("054");
  });

  it("streams are restored too", async () => {
    claude.answer = "התקשרו ל-⟨PHONE_1⟩";
    let out = "";
    for await (const c of chatStream(MSG)) out += c;
    expect(JSON.stringify(claude.seen[0])).not.toContain("054-1471258");
    expect(out).toBe("התקשרו ל-054-1471258");
  });

  it("local routes are never redacted (the text stays on the device)", async () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    ollama.up = true;
    await chat(MSG);
    expect(JSON.stringify(ollamaChat.mock.calls[0][0])).toContain("832095053");
    expect(claude.seen).toHaveLength(0);
  });

  it("the user can turn it off (the request goes as written)", async () => {
    setRedactionEnabled(false);
    claude.answer = "ok";
    await chat(MSG);
    expect(JSON.stringify(claude.seen[0])).toContain("832095053");
  });

  it("preview: the user sees the redacted text and can cancel before anything is sent", async () => {
    setPreviewEnabled(true);
    const shown: string[] = [];
    __setPreview(async (msgs) => {
      shown.push(JSON.stringify(msgs));
      return false;
    });
    await expect(chat(MSG)).rejects.toMatchObject({ name: "AbortError" });
    expect(claude.seen).toHaveLength(0);
    expect(shown[0]).toContain("⟨PHONE_1⟩");
    expect(shown[0]).not.toContain("054-1471258");
  });
});
