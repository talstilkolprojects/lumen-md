/** Plan 6.3 — Nakdimon's input/output processing, the validator, partial niqqud, the editor action and the service gates. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { DAGESH_TABLE, LETTERS_TABLE, NIQQUD_TABLE, SIN_TABLE, canonicalMarks, chunks, decodeChunk, encode, normalizeChar, removeNikud, sameSkeleton, skeleton } from "../text/nikud";
import { addNikud, keepAmbiguousWords, type Infer } from "../text/nikudRun";
import { runNikudCommand } from "../editor/nikudCommand";
import { NikudUnavailableError, __resetNikud, pointHebrew, unpointHebrew } from "../ai/nikudService";

const QAMATS = "ָ", HOLAM = "ֹ", SHIN_DOT = "ׁ", DAGESH = "ּ", HIRIQ = "ִ";

/** A fake model: for each letter, the vowel / dagesh / sin class `pick` returns, with a confidence. */
function fakeInfer(pick: (c: string, i: number) => { n?: string; d?: boolean; s?: string; sure?: number }): Infer & { inputs: string[] } {
  const inputs: string[] = [];
  const fn = (async (ids: Int32Array, rows: number, length: number) => {
    const N = new Float32Array(rows * length * 16), D = new Float32Array(rows * length * 3), S = new Float32Array(rows * length * 4);
    for (let r = 0; r < rows; r++) {
      let text = "";
      for (let i = 0; i < length; i++) {
        const c = LETTERS_TABLE[ids[r * length + i]] ?? "";
        text += c;
        const p = pick(c, i);
        const at = r * length + i;
        const sure = p.sure ?? 5;
        N[at * 16 + Math.max(1, NIQQUD_TABLE.indexOf(p.n ?? "ֿ"))] = sure;
        N[at * 16 + 1] = Math.max(N[at * 16 + 1], p.sure === undefined ? 0 : sure - 0.1);
        D[at * 3 + (p.d ? DAGESH_TABLE.indexOf(DAGESH) : 1)] = 5;
        S[at * 4 + Math.max(1, SIN_TABLE.indexOf(p.s ?? "ֿ"))] = 5;
      }
      inputs.push(text);
    }
    return { N, D, S };
  }) as unknown as Infer & { inputs: string[] };
  fn.inputs = inputs;
  return fn;
}

describe("Nakdimon processing (port of hebrew.py / dataset.py)", () => {
  it("tables have the model's sizes", () => {
    expect(NIQQUD_TABLE).toHaveLength(16);
    expect(DAGESH_TABLE).toHaveLength(3);
    expect(SIN_TABLE).toHaveLength(4);
    expect(LETTERS_TABLE).toHaveLength(1 + 3 + 12 + 27);
  });

  it("normalises characters like hebrew.normalize()", () => {
    expect(normalizeChar("ם")).toBe("ם"); // final letters are valid letters as-is
    expect(normalizeChar("״")).toBe('"');
    expect(normalizeChar("7")).toBe("5");
    expect(normalizeChar("־")).toBe("-");
    expect(normalizeChar("ײ")).toBe("H");
    expect(normalizeChar("a")).toBe("O");
  });

  it("chunks at spaces below maxlen and concatenate back to the input", () => {
    const text = "שלום עולם ".repeat(30) + "😀 סוף";
    const parts = chunks(text, 40);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(39);
  });

  it("encodes ids per character and decodes marks in Nakdimon's order", () => {
    const { ids, length } = encode(["שלום", "ab"]);
    expect(length).toBe(4);
    expect(LETTERS_TABLE[ids[0]]).toBe("ש");
    expect(LETTERS_TABLE[ids[4]]).toBe("O");
    expect(ids[7]).toBe(0); // padding
    const pred = { niqqud: new Int32Array([NIQQUD_TABLE.indexOf(QAMATS), 0, NIQQUD_TABLE.indexOf(HOLAM), 1]), dagesh: new Int32Array([1, 1, 1, 1]), sin: new Int32Array([SIN_TABLE.indexOf(SHIN_DOT), 0, 0, 0]) };
    expect(decodeChunk("שלום", pred, 0, 4)).toBe("ש" + SHIN_DOT + QAMATS + "ל" + "ו" + HOLAM + "ם");
  });

  it("skeleton / canonical marks", () => {
    expect(skeleton("שָׁלוֹם־עוֹלָם׃")).toBe("שלום־עולם׃");
    expect(sameSkeleton("בַּיִת", "בית")).toBe(true);
    expect(sameSkeleton("בַּיִת", "ביתה")).toBe(false);
    expect(canonicalMarks("ש" + QAMATS + SHIN_DOT)).toBe(canonicalMarks("ש" + SHIN_DOT + QAMATS));
    expect(removeNikud("שָׁלוֹם")).toBe("שלום");
  });
});

describe("addNikud", () => {
  it("points Hebrew letters only, removes old points first, keeps everything else", async () => {
    const infer = fakeInfer((c) => (c === "ב" ? { n: QAMATS, d: true } : c === "י" ? { n: HIRIQ } : {}));
    const out = await addNikud("בַּיִת and `code` 42", infer);
    expect(infer.inputs[0].startsWith("בית O")).toBe(true);
    expect(out).toBe("ב" + DAGESH + QAMATS + "י" + HIRIQ + "ת and `code` 42");
    expect(sameSkeleton(out, "בית and `code` 42")).toBe(true);
  });

  it("partial niqqud keeps points only on words with an unsure letter", async () => {
    const infer = fakeInfer((c) => (c === "ס" ? { n: HIRIQ, sure: 1 } : c === "ב" ? { n: QAMATS } : {}));
    const out = await addNikud("בא ספר", infer, { partial: true });
    expect(out).toBe("בא ס" + HIRIQ + "פר");
  });

  it("keepAmbiguousWords maps plain offsets into the pointed text", () => {
    expect(keepAmbiguousWords("אב גד", "אָבָ גָדָ", [[3, 4]])).toBe("אב גָדָ");
  });

  it("stops on abort", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(addNikud("שלום", fakeInfer(() => ({})), { signal: ac.signal })).rejects.toThrow(/aborted/);
  });
});

describe("the editor action", () => {
  const viewWith = (doc: string, from?: number, to?: number) =>
    new EditorView({ state: EditorState.create({ doc, selection: from === undefined ? undefined : EditorSelection.single(from, to) }) });

  it("works on the selection, or the whole note without one", async () => {
    const point = vi.fn(async (t: string) => t.replace(/ל/g, "לְ"));
    const v = viewWith("שלום. עוד שלום", 0, 5);
    expect(await runNikudCommand(v, "add", { point, unpoint: removeNikud })).toBe(true);
    expect(v.state.doc.toString()).toBe("שלְום. עוד שלום");
    const w = viewWith("שָׁלוֹם עוֹלָם");
    expect(await runNikudCommand(w, "remove", { point, unpoint: unpointHebrew })).toBe(true);
    expect(w.state.doc.toString()).toBe("שלום עולם");
  });

  it("no Hebrew, or the text changed meanwhile: nothing is replaced", async () => {
    const v = viewWith("only English");
    expect(await runNikudCommand(v, "add", { point: async (t) => t + "!", unpoint: removeNikud })).toBe(false);
    const w = viewWith("שלום");
    const changed = await runNikudCommand(w, "add", {
      point: async (t) => {
        w.dispatch({ changes: { from: 0, insert: "x" } });
        return t + "ָ";
      },
      unpoint: removeNikud,
    });
    expect(changed).toBe(false);
    expect(w.state.doc.toString()).toBe("xשלום");
  });
});

describe("nikudService gates", () => {
  beforeEach(() => __resetNikud());
  const consent = (answer: boolean) => ({ confirm: vi.fn(async () => answer), t: (k: string) => k });

  it("no host yet (15.9): unavailable, no dialog, no download", async () => {
    const c = consent(true);
    const loadModel = vi.fn();
    await expect(pointHebrew("שלום", { consent: c, loadModel })).rejects.toMatchObject({ name: "NikudUnavailableError", reason: "noHost" });
    expect(c.confirm).not.toHaveBeenCalled();
    expect(loadModel).not.toHaveBeenCalled();
  });

  it("a host but the user declines: declined, nothing downloaded", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => { throw new DOMException("x", "NotFoundError"); } }) } });
    const c = consent(false);
    const loadModel = vi.fn();
    const err = await pointHebrew("שלום", { consent: c, loadModel, base: "https://models.example/" }).catch((e) => e);
    expect(err).toBeInstanceOf(NikudUnavailableError);
    expect(err.reason).toBe("declined");
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect((c.confirm.mock.calls[0] as unknown as [{ message: string }])[0].message).toBe("models.consent.body");
    expect(loadModel).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("consented: the verified bytes go to the worker once, then each request is a point job", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => { throw new DOMException("x", "NotFoundError"); } }) } });
    const posted: Array<Record<string, unknown>> = [];
    const fakeWorker = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage(m: Record<string, unknown>) {
        posted.push(m);
        queueMicrotask(() => this.onmessage?.({ data: { type: "result", id: m.id, value: m.type === "point" ? { text: `${m.text}!`, words: [] } : true } } as MessageEvent));
      },
      terminate() {},
    };
    const loadModel = vi.fn(async (url: string) => {
      expect(url).toBe("https://models.example/nakdimon/Nakdimon.onnx");
      return new ArrayBuffer(8);
    });
    const deps = { consent: consent(true), loadModel, base: "https://models.example/", createWorker: () => fakeWorker as unknown as Worker };
    expect(await pointHebrew("שלום", deps)).toBe("שלום!");
    expect(await pointHebrew("עולם", deps, { partial: true })).toBe("עולם!");
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(posted.map((m) => m.type)).toEqual(["load", "point", "point"]);
    expect(posted[2]).toMatchObject({ partial: true });
    vi.unstubAllGlobals();
  });
});

describe("plan W2.5: other readings in the editor", () => {
  const PATAH = "ַ";
  it("the editor action hands the pointed words to onPointed, relative to where the text starts", async () => {
    const v = new EditorView({ state: EditorState.create({ doc: "x שלום", selection: EditorSelection.single(2, 6) }) });
    const pointed = `ש${PATAH}לום`;
    const words = [{ from: 0, to: pointed.length, alternatives: [{ text: pointed, p: 0.6 }, { text: `ש${QAMATS}לום`, p: 0.4 }] }];
    const onPointed = vi.fn();
    expect(await runNikudCommand(v, "add", { point: async () => ({ text: pointed, words }), unpoint: removeNikud, onPointed })).toBe(true);
    expect(v.state.doc.toString()).toBe(`x ${pointed}`);
    expect(onPointed).toHaveBeenCalledWith(v, 2, words);
  });

  it("a remembered ambiguous word opens its readings; picking one replaces it and keeps the list", async () => {
    const { rememberNikudAlternatives, openNikudAlternativesAt } = await import("../editor/nikudAlternatives");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const first = `ש${PATAH}לום`;
    const second = `ש${QAMATS}לום`;
    const v = new EditorView({ state: EditorState.create({ doc: `x ${first}` }), parent });
    rememberNikudAlternatives(v, 2, [{ from: 0, to: first.length, alternatives: [{ text: first, p: 0.6 }, { text: second, p: 0.4 }] }], (k, vars) => `${k}${vars ? JSON.stringify(vars) : ""}`);
    expect(v.dom.querySelector(".cm-nikud-ambiguous")).toBeTruthy();
    expect(openNikudAlternativesAt(v, 0)).toBe(false);
    expect(openNikudAlternativesAt(v, 3)).toBe(true);
    const options = [...v.dom.querySelectorAll<HTMLButtonElement>(".cm-nikud-alt-option")];
    expect(options.map((b) => b.querySelector("span")?.textContent)).toEqual([first, second]);
    options[1].click();
    expect(v.state.doc.toString()).toBe(`x ${second}`);
    expect(v.dom.querySelector(".cm-nikud-alternatives")).toBeNull();
    // The word keeps its readings, the chosen one first.
    expect(openNikudAlternativesAt(v, 3)).toBe(true);
    expect([...v.dom.querySelectorAll(".cm-nikud-alt-option span")].map((s) => s.textContent)).toEqual([second, first]);
    v.destroy();
    parent.remove();
  });
});
