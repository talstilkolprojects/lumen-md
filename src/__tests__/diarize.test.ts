/**
 * Plan W2.7 — speaker identification: the pyannote-3.1-shaped pieces
 * (powerset decoding, windows, clustering, frames → turns), the pipeline
 * end to end with stand-in networks behind the seam, speakers on transcript
 * sentences, renaming once for the whole note, and the DER used for the
 * acceptance on the golden recordings.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { t } from "../i18n";
import { assignSpeakers, clusterEmbeddings, cosineDistance, framesToTurns, powersetToSpeakers, renameSpeaker, speakersIn, windowStarts, type Turn } from "../meetings/diarize";
import { DIARIZATION_MODELS, diarizationAvailable, diarize, type DiarizationModels, type OrtLike } from "../meetings/diarizeModels";
import { plainTranscript, readTurns, sampleSentences, speakerTranscript, turnsBlock, withLinkedTranscript, type SpokenSentence } from "../meetings/meetingTranscribe";
import {
  der,
  formatRttm,
  parseRttm,
  pooledDer,
  turnsFromNote,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/der.mjs";
import {
  validate,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/meetings/diarization-pin.mjs";

describe("diarization pieces (W2.7)", () => {
  it("powerset classes decode to the active local speakers", () => {
    // frames: silence, speaker 0, speakers 1+2, speaker 2
    const logits = [
      [9, 0, 0, 0, 0, 0, 0],
      [0, 9, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 9],
      [0, 0, 0, 9, 0, 0, 0],
    ].flat();
    expect(powersetToSpeakers(logits, 4)).toEqual([
      [false, false, false],
      [true, false, false],
      [false, true, true],
      [false, false, true],
    ]);
  });

  it("windows of 10 s every second cover the audio and end at its end", () => {
    expect(windowStarts(4)).toEqual([0]);
    expect(windowStarts(12.5)).toEqual([0, 1, 2, 2.5]);
  });

  it("clustering merges close voices and keeps different ones apart (numbered by first appearance)", () => {
    const a = [1, 0.05, 0];
    const b = [0, 1, 0.05];
    expect(cosineDistance(a, a)).toBeCloseTo(0, 9);
    expect(clusterEmbeddings([b, a, [0.02, 0.98, 0.06], [0.97, 0.03, 0.01]])).toEqual([0, 1, 0, 1]);
    expect(clusterEmbeddings([a, b, [0, 0, 1]], 0.7045, 2).filter((x, i, xs) => xs.indexOf(x) === i)).toHaveLength(2);
  });

  it("frames of overlapping windows vote into turns; short gaps bridged, blips dropped", () => {
    const fs = 0.1;
    const turns = framesToTurns(
      [
        { window: 0, frames: [0, 1, 2, 3, 4, 6, 7, 8, 9] }, // speaker A 0–1 s with a 0.1 s gap
        { window: 0, frames: [15, 16, 17, 18, 19] }, // speaker B 1.5–2 s
        { window: 1, frames: [5, 6, 7, 8, 9] }, // speaker B again (window 1 → 1.5–2 s)
        { window: 1, frames: [20] }, // a 0.1 s blip of A at 3 s
      ],
      [0, 1, 1, 0],
      { frameSec: fs, duration: 4 },
    );
    expect(turns).toEqual([
      { start: 0, end: 1, speaker: "S1" },
      { start: 1.5, end: 2, speaker: "S2" },
    ]);
  });

  it("each sentence gets the speaker it overlaps most, else the nearest turn", () => {
    const turns: Turn[] = [
      { start: 0, end: 5, speaker: "S1" },
      { start: 5, end: 9, speaker: "S2" },
    ];
    const out = assignSpeakers(
      [
        { start: 0.5, end: 4, text: "a" },
        { start: 4, end: 8, text: "b" },
        { start: 9.5, end: 11, text: "c" },
      ],
      turns,
    );
    expect(out.map((s) => s.speaker)).toEqual(["S1", "S2", "S2"]);
    expect(assignSpeakers([{ start: 0, end: 1 }], [])[0].speaker).toBeNull();
  });
});

/* A synthetic two-person meeting: speaker A at amplitude 0.2, B at 0.6, silence between. */
const RATE = 16_000;
const SCRIPT: Turn[] = [
  { start: 0.5, end: 6, speaker: "A" },
  { start: 7, end: 13, speaker: "B" },
  { start: 13.5, end: 19, speaker: "A" },
  { start: 20, end: 24, speaker: "B" },
];
function meetingAudio(): Float32Array {
  const x = new Float32Array(25 * RATE);
  for (const tr of SCRIPT) for (let i = Math.round(tr.start * RATE); i < Math.round(tr.end * RATE); i++) x[i] = (tr.speaker === "A" ? 0.2 : 0.6) * (i % 2 ? 1 : -1);
  return x;
}

const FRAMES = 589;
const meanAbs = (x: ArrayLike<number>, a: number, b: number) => {
  let s = 0;
  for (let i = a; i < b; i++) s += Math.abs(x[i]);
  return b > a ? s / (b - a) : 0;
};

/** Stand-ins for the two networks: segmentation by loudness (one local speaker per loudness), embedding by loudness too. */
function fakeOrt(): OrtLike & { created: number } {
  class Tensor {
    type: string;
    data: Float32Array;
    dims: number[];
    constructor(type: string, data: Float32Array, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const o = {
    created: 0,
    Tensor: Tensor as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create(model: Uint8Array) {
        o.created++;
        const kind = new TextDecoder().decode(model);
        return {
          async run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>> {
            const t = Object.values(feeds)[0] as Tensor;
            if (kind === "seg") {
              const n = t.dims[2];
              const out = new Float32Array(FRAMES * 7);
              for (let f = 0; f < FRAMES; f++) {
                const a = Math.round(f * 0.016875 * RATE);
                const m = meanAbs(t.data, a, Math.min(n, a + Math.round(0.016875 * RATE)));
                // Local speaker slots are arbitrary per window: loud → slot 2, quiet → slot 0.
                const cls = m < 0.05 ? 0 : m < 0.4 ? 1 : 3;
                out[f * 7 + cls] = 5;
              }
              return { logits: { data: out, dims: [1, FRAMES, 7] } };
            }
            const loud = meanAbs(t.data, 0, t.data.length) > 0.4;
            return { embs: { data: Float32Array.from(loud ? [0.1, 1, 0.05] : [1, 0.08, 0.1]), dims: [1, 3] } };
          },
        };
      },
    },
  };
  return o;
}

const pin = { repo: "owner/name", revision: "a".repeat(40), bytes: 3, sha256: "b".repeat(64), license: "MIT" };
const TEST_MODELS: DiarizationModels = {
  segmentation: { ...DIARIZATION_MODELS.segmentation, ...pin, file: "seg.onnx" },
  embedding: { ...DIARIZATION_MODELS.embedding, ...pin, file: "emb.onnx", int16Scale: false, cmn: false },
  threshold: 0.7045,
};

describe("the diarization pipeline behind its seam (W2.7)", () => {
  it("is unavailable until both networks are pinned, and refuses to run", async () => {
    expect(diarizationAvailable()).toBe(false);
    expect(diarizationAvailable(TEST_MODELS)).toBe(true);
    expect(diarizationAvailable({ ...TEST_MODELS, embedding: { ...TEST_MODELS.embedding, revision: "main" } })).toBe(false);
    await expect(diarize(new Float32Array(16), { ort: fakeOrt(), load: async () => new Uint8Array(), fbank: () => [] })).rejects.toThrow(/not pinned/);
  });

  it("finds both speakers of a 25 s meeting with DER under 5%", async () => {
    const ort = fakeOrt();
    const loaded: string[] = [];
    const progress: number[] = [];
    const turns = await diarize(
      meetingAudio(),
      {
        ort,
        load: async (m) => {
          loaded.push(m.file!);
          return new TextEncoder().encode(m.file === "seg.onnx" ? "seg" : "emb");
        },
        // One "feature" per frame (the loudness) is all the stand-in embedding needs.
        fbank: (x) => Array.from({ length: Math.max(1, Math.floor(x.length / 160)) }, (_, i) => Float32Array.of(meanAbs(x, i * 160, (i + 1) * 160))),
        onProgress: (d) => progress.push(d),
      },
      TEST_MODELS,
    );
    expect(loaded.sort()).toEqual(["emb.onnx", "seg.onnx"]);
    expect(ort.created).toBe(2);
    expect(progress.at(-1)).toBe(windowStarts(25).length);
    expect(new Set(turns.map((t) => t.speaker))).toEqual(new Set(["S1", "S2"]));
    expect(turns[0].speaker).toBe("S1");
    const r = der(SCRIPT, turns, { collar: 0 });
    expect(r.der).toBeLessThan(0.05);
  });

  it("stops when cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      diarize(meetingAudio(), { ort: fakeOrt(), load: async (m) => new TextEncoder().encode(m.file === "seg.onnx" ? "seg" : "emb"), fbank: () => [], signal: ac.signal }, TEST_MODELS),
    ).rejects.toThrow(/aborted/);
  });
});

describe("speakers in the note (W2.7)", () => {
  const spoken: SpokenSentence[] = [
    { start: 7, end: 9.5, text: "שלום לכולם.", speaker: "S1" },
    { start: 10, end: 14, text: "נתחיל בתקציב של הרבעון.", speaker: "S2" },
    { start: 15, end: 16, text: "כן.", speaker: "S1" },
    { start: 17, end: 18, text: "unknown", speaker: null },
  ];

  it("labels every line, links its time to the audio, and keeps the turns", () => {
    const md = speakerTranscript(spoken, "attachments/2026-11-10-meeting.m4a");
    expect(md.split("\n")[0]).toBe("**S1:** [▶ 0:07](<attachments/2026-11-10-meeting.m4a#t=7,10>) שלום לכולם.");
    expect(md.split("\n")[3]).toBe("[▶ 0:17](<attachments/2026-11-10-meeting.m4a#t=17,18>) unknown");
    expect(speakerTranscript(spoken.slice(0, 1), null)).toBe("**S1:** `0:07` שלום לכולם.");
    expect(plainTranscript(spoken)).toBe("S1: שלום לכולם.\nS2: נתחיל בתקציב של הרבעון.\nS1: כן.\nunknown");
    expect(speakersIn(md)).toEqual(["S1", "S2"]);
    expect(sampleSentences(spoken)).toEqual(new Map([["S1", "שלום לכולם."], ["S2", "נתחיל בתקציב של הרבעון."]]));
    const turns: Turn[] = [{ start: 7, end: 9.5, speaker: "S1" }, { start: 10, end: 14, speaker: "S2" }];
    const block = turnsBlock(turns);
    expect(readTurns(`x\n\n${block}\n`)).toEqual(turns);
    expect(turnsFromNote(`x\n\n${block}\n`)).toEqual(turns);
    expect(readTurns("no block")).toBeNull();
  });

  it("renaming once changes every label and the turns block, and nothing else", () => {
    const md = `## Meeting\n\n- S1 to send the budget\n\n${speakerTranscript(spoken, null)}\n\n**S10:** other\n\n${turnsBlock([{ start: 7, end: 9.5, speaker: "S1" }, { start: 30, end: 31, speaker: "S10" }])}\n`;
    const out = renameSpeaker(md, "S1", "דנה");
    expect(speakersIn(out)).toEqual(["דנה", "S2", "S10"]);
    expect(out).toContain("- S1 to send the budget");
    expect(readTurns(out)!.map((t) => t.speaker)).toEqual(["דנה", "S10"]);
    expect(renameSpeaker(md, "S1", "**x:**\n")).toContain("**x:**");
    expect(renameSpeaker(md, "S1", "  ")).toBe(md);
  });

  it("the linked transcript replaces the plain one inside the meeting note", () => {
    const plain = plainTranscript(spoken);
    const note = `## Decisions\n- x\n\n<details><summary>Transcript</summary>\n\n${plain}\n\n</details>`;
    const linked = speakerTranscript(spoken, null);
    expect(withLinkedTranscript(note, plain, linked)).toBe(note.replace(plain, linked));
    expect(withLinkedTranscript("no transcript", plain, linked)).toBe("no transcript");
  });
});

describe("DER and the pin tool (W2.7 acceptance tools)", () => {
  const ref: Turn[] = [
    { start: 0, end: 10, speaker: "A" },
    { start: 10, end: 20, speaker: "B" },
  ];

  it("DER is 0 for a perfect (renamed) hypothesis, 0.5 for one speaker for two, 1 for nothing", () => {
    expect(der(ref, ref.map((t) => ({ ...t, speaker: t.speaker === "A" ? "S2" : "S1" }))).der).toBe(0);
    expect(der(ref, [{ start: 0, end: 20, speaker: "S1" }]).der).toBeCloseTo(0.5, 6);
    expect(der(ref, []).der).toBe(1);
    const r = der(ref, [{ start: 0, end: 12, speaker: "S1" }, { start: 12, end: 21, speaker: "S2" }]);
    expect(r.confusion).toBeCloseTo(2, 6);
    expect(r.falseAlarm).toBeCloseTo(1, 6);
    expect(der(ref, [{ start: 0, end: 12, speaker: "S1" }, { start: 12, end: 20, speaker: "S2" }], { collar: 2.5 }).der).toBe(0);
    expect(pooledDer([r, { ...r, missed: 0, falseAlarm: 0, confusion: 0 }])).toBeCloseTo(3 / 40, 6);
  });

  it("RTTM round-trips", () => {
    expect(parseRttm(formatRttm(ref, "m1"))).toEqual(ref);
    expect(parseRttm("SPEAKER m 1 1.5 2 <NA> <NA> דנה <NA> <NA>\n;; comment")).toEqual([{ start: 1.5, end: 3.5, speaker: "דנה" }]);
  });

  it("the pin tool accepts only exact values and permissive licences", () => {
    const ok = { model: "segmentation", repo: "o/n", revision: "c".repeat(40), file: "onnx/model.onnx", bytes: "5905440", sha256: "d".repeat(64), license: "MIT" };
    expect(validate(ok)).toEqual([]);
    expect(validate({ ...ok, revision: "main" })).toHaveLength(1);
    expect(validate({ ...ok, file: "../x.onnx" })).toHaveLength(1);
    expect(validate({ ...ok, license: "CC-BY-NC-4.0" })).toHaveLength(1);
  });
});

describe("meeting speaker strings ship with their chunk (W2.7)", () => {
  const SRC = resolve(__dirname, "..");
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "__tests__") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push({ path: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(SRC);
  const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "meetingSpeakers.json"), "utf8")) as Record<string, string>;
  const index = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");

  it("no lazy key is in the startup bundle; the palette labels are", () => {
    for (const k of Object.keys(lazy)) expect(index.includes(`"${k}"`), k).toBe(false);
    expect(index).toContain('"cmd.voice.meetingFile"');
    expect(index).toContain('"cmd.speakers.rename"');
  });

  it("only speakerStrings imports the JSON, only meetingTranscribe imports that, and the commands load it lazily", () => {
    expect(files.filter((f) => f.text.includes("i18n/lazy/meetingSpeakers.json")).map((f) => f.path)).toEqual(["meetings/speakerStrings.ts"]);
    expect(files.filter((f) => /^import "\.\/speakerStrings";/m.test(f.text)).map((f) => f.path)).toEqual(["meetings/meetingTranscribe.ts"]);
    for (const f of files) {
      expect(/^import [^;]*from "[./]*(meetings\/)?meetingTranscribe";/m.test(f.text), f.path).toBe(false);
      expect(/^import [^;]*from "[./]*(meetings\/)?diarize(Models)?";/m.test(f.text) && !f.path.startsWith("meetings/"), f.path).toBe(false);
    }
    expect(files.some((f) => /^commands\//.test(f.path) && /import\("(\.\.\/)+meetings\/meetingTranscribe"\)/.test(f.text))).toBe(true);
  });

  it("t() resolves the lazy keys once the module is loaded", () => {
    expect(t("speakers.renamed", { from: "S1", to: "Dana" })).toBe("Renamed S1 to Dana everywhere in this note.");
  });
});
