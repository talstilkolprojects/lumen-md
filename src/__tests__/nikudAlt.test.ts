/**
 * Plan W2.5 — niqqud at Dicta level: alternatives per word (beam over the
 * letters' options, the model's reading first, every reading passing the
 * consonant validator), the DictaBERT-char-menaked input/output side
 * (src/text/menaked.ts) and the detailed run that feeds the editor's list.
 */
import { describe, it, expect } from "vitest";
import { DAGESH_TABLE, LETTERS_TABLE, NIQQUD_TABLE, SIN_TABLE, sameSkeleton } from "../text/nikud";
import { combineHeads, isAmbiguous, nakdimonOptions, softmaxAt, topClasses, wordAlternatives, type LetterOption } from "../text/nikudAlt";
import { classMarks, decodeMenaked, encodeMenaked, parseMenakedSpec, type MenakedSpec } from "../text/menaked";
import { addNikud, addNikudDetailed, type Infer, type NikudEngine } from "../text/nikudRun";

const PATAH = "ַ", QAMATS = "ָ", SEGOL = "ֶ", HIRIQ = "ִ", SHVA = "ְ", DAGESH = "ּ", SHIN_DOT = "ׁ", SIN_DOT = "ׂ", HOLAM = "ֹ";

describe("nikudAlt", () => {
  it("softmax and top classes", () => {
    const p = softmaxAt([0, Math.log(3), 0, Math.log(1)], 0, 4);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(topClasses(p, 2).map((x) => x.k)).toEqual([1, 2]);
    expect(topClasses(p, 2, 0).map((x) => x.k)).toEqual([1, 0]);
  });

  it("combines heads into a letter's options, most probable first, merging equal mark sets", () => {
    const opts = combineHeads([
      [
        { marks: DAGESH, p: 0.6 },
        { marks: "", p: 0.4 },
      ],
      [
        { marks: QAMATS, p: 0.7 },
        { marks: PATAH, p: 0.3 },
      ],
    ]);
    expect(opts.map((o) => o.marks)).toEqual([DAGESH + QAMATS, QAMATS, DAGESH + PATAH, PATAH]);
    expect(opts[0].p).toBeCloseTo(0.42, 6);
    expect(combineHeads([[{ marks: "", p: 0.5 }, { marks: "", p: 0.5 }]])).toEqual([{ marks: "", p: 1 }]);
  });

  it("word alternatives: the best combination first, consonants always kept, at most k", () => {
    const o = (...xs: Array<[string, number]>): LetterOption[] => xs.map(([marks, p]) => ({ marks, p }));
    // ספר: sefer / safar / sapar / sfar…
    const alts = wordAlternatives("ספר", [o([SEGOL, 0.55], [QAMATS, 0.45]), o([SEGOL, 0.5], [QAMATS, 0.5]), o(["", 0.9], [SHVA, 0.1])], 3);
    expect(alts).toHaveLength(3);
    expect(alts[0].text).toBe("ס" + SEGOL + "פ" + SEGOL + "ר");
    expect(alts.every((a) => sameSkeleton(a.text, "ספר"))).toBe(true);
    expect(alts[0].p).toBeGreaterThanOrEqual(alts[1].p);
    expect(isAmbiguous(alts)).toBe(true);
    // A word the model is sure of is not ambiguous.
    const sure = wordAlternatives("של", [o([SHIN_DOT + SHVA, 0.98], [SIN_DOT + SHVA, 0.02]), o(["", 1])]);
    expect(isAmbiguous(sure)).toBe(false);
    // A geresh or a quote inside a word is kept as is.
    expect(wordAlternatives("צ'יפס", [o([HIRIQ, 1]), undefined, o(["", 1]), o(["", 1]), o(["", 1])])[0].text).toBe("צ" + HIRIQ + "'יפס");
  });

  it("Nakdimon's options start with what decodeChunk writes and skip marks the letter cannot carry", () => {
    // One position, logits: vowel qamats (strong) then patah; dagesh yes; sin: shin dot.
    const N = new Float32Array(16), D = new Float32Array(3), S = new Float32Array(4);
    N[NIQQUD_TABLE.indexOf(QAMATS)] = 4;
    N[NIQQUD_TABLE.indexOf(PATAH)] = 3;
    D[DAGESH_TABLE.indexOf(DAGESH)] = 5;
    S[SIN_TABLE.indexOf(SHIN_DOT)] = 5;
    const shin = nakdimonOptions("ש", { N, D, S }, 0);
    expect(shin[0].marks).toBe(DAGESH + SHIN_DOT + QAMATS);
    const alef = nakdimonOptions("א", { N, D, S }, 0);
    expect(alef.every((x) => !x.marks.includes(DAGESH) && !x.marks.includes(SHIN_DOT))).toBe(true);
    expect(alef[0].marks).toBe(QAMATS);
  });
});

/** A spec like the one the export script writes, with a tiny vocabulary. */
function spec(): MenakedSpec {
  const vocab: Record<string, number> = {};
  [..."אבגדהוזחטיכלמנסעפצקרשתךםןףץ ,."].forEach((c, i) => (vocab[c] = 10 + i));
  return parseMenakedSpec({
    vocab,
    cls: 2,
    sep: 3,
    pad: 0,
    unk: 1,
    nikudClasses: ["", "<MAT_LECT>", SHVA, PATAH, QAMATS, SEGOL, HIRIQ, HOLAM, DAGESH + PATAH, DAGESH + QAMATS],
    shinClasses: [SHIN_DOT, SIN_DOT],
    maxTokens: 512,
    inputs: { ids: "input_ids", mask: "attention_mask" },
    outputs: { nikud: "nikud", shin: "shin" },
  });
}

describe("DictaBERT-char-menaked (menaked.ts)", () => {
  it("refuses a file that is not a spec", () => {
    expect(() => parseMenakedSpec({ vocab: {} })).toThrow(/not a DictaBERT-char-menaked spec/);
    expect(() => parseMenakedSpec(null)).toThrow();
  });

  it("encodes [CLS] chars [SEP], padded, unknown characters as [UNK]", () => {
    const s = spec();
    const { ids, mask, length } = encodeMenaked(["שלום", "x"], s);
    expect(length).toBe(6);
    expect([...ids.slice(0, 6)].map(Number)).toEqual([2, s.vocab["ש"], s.vocab["ל"], s.vocab["ו"], s.vocab["ם"], 3]);
    expect([...ids.slice(6, 12)].map(Number)).toEqual([2, 1, 3, 0, 0, 0]);
    expect([...mask.slice(6, 12)].map(Number)).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it("writes only real marks a letter can carry: a special label writes nothing, a dagesh only where it can stand", () => {
    expect(classMarks("<MAT_LECT>", "ו")).toBe("");
    expect(classMarks(DAGESH + PATAH, "ב")).toBe(DAGESH + PATAH);
    expect(classMarks(PATAH + DAGESH, "ב")).toBe(DAGESH + PATAH);
    expect(classMarks(DAGESH + PATAH, "ח")).toBe(PATAH);
    expect(classMarks(QAMATS, "ם")).toBe("");
  });

  it("decodes per character after [CLS], shin dot from its own head, options best first", () => {
    const s = spec();
    const chunk = "שבת";
    const length = chunk.length + 2;
    const nN = s.nikudClasses.length;
    const nikud = new Float32Array(length * nN);
    const shin = new Float32Array(length * 2);
    const set = (tok: number, k: number, v: number) => (nikud[tok * nN + k] = v);
    set(1, s.nikudClasses.indexOf(PATAH), 5); // ש
    set(2, s.nikudClasses.indexOf(DAGESH + PATAH), 5); // ב
    set(2, s.nikudClasses.indexOf(PATAH), 4.5);
    set(3, 0, 5); // ת: nothing
    shin[1 * 2 + 0] = 4; // shin dot
    const r = decodeMenaked(chunk, { nikud, shin }, 0, length, s);
    expect(r.text).toBe("ש" + SHIN_DOT + PATAH + "ב" + DAGESH + PATAH + "ת");
    expect(r.options[1]![0].marks).toBe(DAGESH + PATAH);
    expect(r.options[1]![1].marks).toBe(PATAH);
    expect(r.unsure[1]).toBe(true);
    expect(r.unsure[0]).toBe(false);
  });
});

describe("addNikudDetailed", () => {
  /** An engine that points every letter with patah, and offers qamats as the second option at 40 %. */
  const engine: NikudEngine = {
    maxlen: 100,
    async run(batch, o) {
      return batch.map((chunk) => ({
        text: [...chunk].map((c) => (/[א-ת]/.test(c) && c !== "ם" ? c + PATAH : c)).join(""),
        options: o.withOptions
          ? [...chunk].map((c) =>
              /[א-ת]/.test(c) && c !== "ם"
                ? [
                    { marks: PATAH, p: 0.6 },
                    { marks: QAMATS, p: 0.4 },
                  ]
                : /[א-ת]/.test(c)
                  ? [{ marks: "", p: 1 }]
                  : undefined,
            )
          : undefined,
        unsure: [...chunk].map((c) => c === "ל"),
      }));
    },
  };

  it("returns the pointed text and each word's readings, the text's own first, with offsets into the output", async () => {
    const r = await addNikudDetailed("כל דבר, שלום", engine);
    expect(r.text).toBe(`כ${PATAH}ל${PATAH} ד${PATAH}ב${PATAH}ר${PATAH}, ש${PATAH}ל${PATAH}ו${PATAH}ם`);
    expect(r.words).toHaveLength(3);
    for (const w of r.words) {
      expect(r.text.slice(w.from, w.to)).toBe(w.alternatives[0].text);
      expect(w.alternatives.length).toBeGreaterThan(1);
      for (const a of w.alternatives) expect(sameSkeleton(a.text, w.alternatives[0].text)).toBe(true);
    }
    expect(r.words[2].alternatives.map((a) => a.text)).toContain(`ש${QAMATS}ל${PATAH}ו${PATAH}ם`);
  });

  it("partial: only the ambiguous words are pointed and listed", async () => {
    const r = await addNikudDetailed("כל דבר", engine, { partial: true });
    expect(r.text).toBe(`כ${PATAH}ל${PATAH} דבר`);
    expect(r.words.map((w) => r.text.slice(w.from, w.to))).toEqual([`כ${PATAH}ל${PATAH}`]);
  });

  it("the validator holds for engines too: a model that changes a consonant is refused", async () => {
    const bad: NikudEngine = { maxlen: 100, run: async (batch) => batch.map((c) => ({ text: c.replace("ב", "כ"), unsure: [] })) };
    await expect(addNikud("דבר", bad)).rejects.toThrow(/consonants changed/);
  });

  it("Nakdimon through the old Infer signature still works, with options", async () => {
    const infer: Infer = async (ids, rows, length) => {
      const N = new Float32Array(rows * length * 16), D = new Float32Array(rows * length * 3), S = new Float32Array(rows * length * 4);
      for (let p = 0; p < rows * length; p++) {
        N[p * 16 + NIQQUD_TABLE.indexOf(QAMATS)] = 3;
        N[p * 16 + NIQQUD_TABLE.indexOf(PATAH)] = 2.5;
        D[p * 3 + 1] = 5;
        S[p * 4 + 1] = 5;
      }
      expect(LETTERS_TABLE[ids[0]]).toBe("ד");
      return { N, D, S };
    };
    const r = await addNikudDetailed("דג", infer);
    expect(r.text).toBe(`ד${QAMATS}ג${QAMATS}`);
    expect(r.words[0].alternatives.map((a) => a.text)).toContain(`ד${PATAH}ג${QAMATS}`);
  });
});
