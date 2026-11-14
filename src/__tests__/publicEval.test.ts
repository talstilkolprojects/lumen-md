/**
 * W11.H5 / H6 / H9 / H10 / H14 / H18 — the public Hebrew benchmark harness.
 *
 * The manifests and the registry are the real committed files. Every data
 * item below is SYNTHETIC (written here, labelled so) and every engine is a
 * stand-in: these tests check the loaders, the metrics and the gates, not
 * any model. Real numbers come only from `npm run eval:public -- run …` on
 * downloaded data (owed, Mac).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { validateManifest, isPinned, idsDigest, type PublicManifest } from "../eval/public/manifest";
import { checkPublicEval, resultPath, registryRevision, latestResults, type PublicResult } from "../eval/public/gate";
import { editDistance, wer, cer, median, microRate } from "../eval/public/metrics";
import { ivritLeaderboard, whisperBasic, normalizer } from "../eval/public/normalize";
import { parseFleursTsv, parseAudioJsonl, scoreAsr, type AsrEngine } from "../eval/public/adapters/asr";
import { freezePrompts, selectFrozen, scoreRoundTrip, voicePasses } from "../eval/public/adapters/ttsRoundTrip";
import { parseNakdimonTest, scoreNikud, compareNikud, undot } from "../eval/public/adapters/nikud";
import { parseMilimJsonl, scoreG2p, renikudAllowed } from "../eval/public/adapters/g2p";
import { parseImageJsonl, scoreHandwriting, wordCoverage, handwritingExposed } from "../eval/public/adapters/handwriting";
// @ts-expect-error — plain .mjs helper without types
import { validateEntry } from "../../scripts/lib/licenses.mjs";
// @ts-expect-error — plain .mjs helper without types
import { planSteps, isPublicEvalInput, isBidiConformanceInput, BIDI_TEST_DATA } from "../../scripts/lib/ciLocal.mjs";

const manifests = readdirSync("eval/public")
  .filter((n) => n.endsWith(".json") && !n.startsWith("_"))
  .map((n) => ({ stem: n.slice(0, -5), json: JSON.parse(readFileSync(`eval/public/${n}`, "utf8")) as PublicManifest }));
const registry = JSON.parse(readFileSync("models/registry.json", "utf8")).models as { id: string; benchmarks?: string[]; hosting?: { revision?: string | null } }[];

describe("manifests (eval/public/*.json)", () => {
  it("every committed manifest is valid, and the ones W11.H asks for exist", () => {
    for (const m of manifests) expect(validateManifest(m.json, m.stem), m.stem).toEqual([]);
    const ids = manifests.map((m) => m.stem);
    for (const id of ["unicode-bidi", "asr-ivrit-eval-d1", "asr-ivrit-eval-whatsapp", "asr-fleurs-he", "asr-voxknesset", "asr-fleurs-yi", "tts-insva-fleurs-he", "nikud-nakdimon-test", "g2p-milim", "ocr-handwriting-ivrit"]) expect(ids).toContain(id);
  });
  it("speech sets use the ivrit.ai leaderboard normaliser, so WER compares with the public table", () => {
    for (const id of ["asr-ivrit-eval-d1", "asr-ivrit-eval-whatsapp", "asr-fleurs-he", "tts-insva-fleurs-he"]) expect(manifests.find((m) => m.stem === id)!.json.normalizer).toBe("ivrit-leaderboard");
  });
  it("an unpinned manifest must say where it is pinned, and does not count as pinned", () => {
    const m = structuredClone(manifests.find((x) => x.stem === "asr-fleurs-he")!.json);
    expect(isPinned(m)).toBe(false);
    m.owed = [];
    expect(validateManifest(m, "asr-fleurs-he").join()).toMatch(/owed/);
  });
  it("a Hugging Face revision must be a commit; a GitHub commit pins every file", () => {
    const m = structuredClone(manifests.find((x) => x.stem === "asr-fleurs-he")!.json);
    m.dataset.revision = "main";
    expect(validateManifest(m, "asr-fleurs-he").join()).toMatch(/40-hex/);
    const n = manifests.find((x) => x.stem === "nikud-nakdimon-test")!.json;
    expect(isPinned(n)).toBe(true);
  });
  it("the frozen TTS prompt set is 200 prompts, pinned together with its digest", async () => {
    const t = structuredClone(manifests.find((x) => x.stem === "tts-insva-fleurs-he")!.json);
    expect(t.frozen!.count).toBe(200);
    t.frozen!.ids = ["1"];
    expect(validateManifest(t, "tts-insva-fleurs-he").join()).toMatch(/exactly 200/);
    expect(await idsDigest(["b", "a"])).toBe(await idsDigest(["a", "b"]));
  });
});

const goodResult = (over: Partial<PublicResult> = {}): PublicResult => ({
  schema: 1,
  task: "nikud-nakdimon-test",
  dataset: { id: "elazarg/nakdimon", revision: "a06ebfd032548b132ac2da2f5aab1289de5ae5f2", split: "test" },
  model: { id: "some-model", revision: "r1" },
  engine: "test",
  normalizer: "none",
  n: 1,
  metrics: { wor: 0.9 },
  date: "2026-11-14T00:00:00.000Z",
  command: "npm run eval:public -- run nikud-nakdimon-test",
  synthetic: false,
  ...over,
});
const gate = (results: { path: string; json: unknown }[], files: string[] = [], reg = registry) => checkPublicEval({ manifests, results, registry: reg, files });

describe("the gate (ci:local step public-eval)", () => {
  it("passes on the committed manifests and an up-to-date result", () => {
    const r = goodResult();
    expect(gate([{ path: resultPath(r.task, r.model.id, r.model.revision), json: r }])).toEqual([]);
  });
  it("fails on a result older than the model revision the registry pins", () => {
    const reg = [{ id: "some-model", hosting: { revision: "r2" } }];
    const r = goodResult();
    expect(gate([{ path: resultPath(r.task, "some-model", "r1"), json: r }], [], reg).join()).toMatch(/stale: describes some-model@r1, models\/registry\.json pins r2/);
    expect(registryRevision(registry.find((e) => e.id === "ivrit-ai/zipformer2-66m-streaming-he"))).toBe("ee769a2a13b887f91572eec349458bfb0fe79e7a");
  });
  it("fails on a result measured on another dataset revision, without a command, or from a synthetic fixture", () => {
    const at = (r: PublicResult) => ({ path: resultPath(r.task, r.model.id, r.model.revision), json: r });
    expect(gate([at(goodResult({ dataset: { id: "x", revision: "0000000000000000000000000000000000000000", split: "test" } }))]).join()).toMatch(/stale: measured on dataset revision/);
    expect(gate([at(goodResult({ command: "" }))]).join()).toMatch(/no reproduction command/);
    expect(gate([at(goodResult({ synthetic: true }))]).join()).toMatch(/synthetic/);
    expect(gate([{ path: "eval/results/nikud-nakdimon-test/wrong.json", json: goodResult() }]).join()).toMatch(/must be at eval\/results\/nikud-nakdimon-test\/some-model@r1\.json/);
  });
  it("fails on any dataset file in the repo or in dist; manifests alone pass", () => {
    expect(gate([], ["eval/public/asr-fleurs-he.json", "eval/public/README.md"])).toEqual([]);
    expect(gate([], ["eval/public/.data/unicode-bidi/BidiCharacterTest.txt"]).join()).toMatch(/must not be committed/);
    expect(gate([], ["eval/public/clips/a.wav"]).join()).toMatch(/dataset file/);
    expect(gate([], ["dist/assets/data/he_il/test.tsv"]).join()).toMatch(/manifest lists/);
  });
  it("latestResults keeps the newest per task and model", () => {
    const a = goodResult({ date: "2026-01-01T00:00:00Z" });
    const b = goodResult({ date: "2026-02-01T00:00:00Z", metrics: { wor: 0.95 } });
    expect(latestResults([a, b])).toEqual([b]);
  });
  it("ci:local runs the gate on public-benchmark diffs, and bidi conformance only when the data is downloaded", () => {
    const pkg = { scripts: { "eval:public": "x" } };
    const steps = (changed: string[] | null, exists: (p: string) => boolean) => Object.fromEntries((planSteps({ pkg, exists, changed, flags: {} }) as { id: string; skipReason?: string; cmd: string[] }[]).map((s) => [s.id, s]));
    const full = steps(null, (p) => p !== BIDI_TEST_DATA);
    expect(full["public-eval"].cmd).toEqual(["npm", "run", "-s", "eval:public", "--", "check"]);
    expect(full["public-eval"].skipReason).toBeUndefined();
    expect(full["bidi-conformance"].skipReason).toMatch(/data not downloaded .*fetch unicode-bidi/);
    expect(steps(null, () => true)["bidi-conformance"].skipReason).toBeUndefined();
    expect(steps(["src/ai/tts.ts"], () => true)["public-eval"].skipReason).toMatch(/no public-benchmark input/);
    expect(isPublicEvalInput("models/registry.json")).toBe(true);
    expect(isBidiConformanceInput("src/lib/bidiDirection.ts")).toBe(true);
    expect(isBidiConformanceInput("src/lib/textDirection.ts")).toBe(false);
  });
});

describe("registry (W11.H5 links, H8, H10, H18 entries)", () => {
  it("every benchmark a registry entry links to is a committed manifest", () => {
    const ids = new Set(manifests.map((m) => m.stem));
    const linked = registry.filter((e) => e.benchmarks);
    expect(linked.length).toBeGreaterThanOrEqual(8);
    for (const e of linked) for (const b of e.benchmarks!) expect(ids.has(b), `${e.id} → ${b}`).toBe(true);
  });
  it("the new entries pass the licence gate's entry check, with the decisions W11.H8/H10 ask for", () => {
    const by = new Map(registry.map((e) => [e.id, e as Record<string, unknown>]));
    for (const id of ["chatterbox-multilingual", "phonikud-onnx", "renikud", "ivrit-ai/yi-whisper-large-v3-turbo"]) expect(validateEntry(by.get(id)), id).toEqual([]);
    const cb = by.get("chatterbox-multilingual")!;
    expect([cb.license, cb.class, cb.delivery]).toEqual(["MIT", "unknown", "none"]);
    expect(String(cb.decision)).toMatch(/PerTh|training data/);
    expect(by.get("phonikud-onnx")!.license).toBe("MIT");
    expect(String(by.get("phonikud-onnx")!.attribution)).toMatch(/CC BY 4\.0/);
    expect(by.get("renikud")!.class).toBe("unknown");
    expect(by.get("phonikud-tts")!.class).toBe("forbidden");
  });
});

describe("metrics", () => {
  it("edit distance, micro WER/CER, median", () => {
    expect(editDistance([..."kitten"], [..."sitting"])).toBe(3);
    expect(wer([{ ref: "a b c d", hyp: "a x c" }])).toBe(0.5);
    expect(cer([{ ref: "abcd", hyp: "abce" }, { ref: "ab", hyp: "ab" }])).toBeCloseTo(1 / 6);
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(Number.isNaN(microRate([]))).toBe(true);
  });
});

describe("W11.H6 ivrit.ai leaderboard normaliser (port; parity with the Python original is owed)", () => {
  it("Whisper's BasicTextNormalizer: brackets dropped, punctuation and symbols become spaces, lower case", () => {
    expect(whisperBasic("Hello, World! [music] (laughs) <noise>")).toBe("hello world");
    expect(whisperBasic("a—b")).toBe("a b");
  });
  it("niqqud and cantillation go, maqaf splits, invisible controls are deleted, not spaced", () => {
    expect(ivritLeaderboard("שָׁלוֹם")).toBe("שלום");
    expect(ivritLeaderboard("בְּרֵאשִׁ֖ית")).toBe("בראשית");
    expect(ivritLeaderboard("בית־ספר")).toBe("בית ספר");
    expect(ivritLeaderboard("של‏ום")).toBe("שלום");
    expect(ivritLeaderboard("  שלום,   עולם. ")).toBe("שלום עולם");
  });
  it("is found by id, and an unknown id fails", () => {
    expect(normalizer("ivrit-leaderboard")("א.")).toBe("א");
    expect(() => normalizer("nope")).toThrow(/unknown normaliser/);
  });
});

// SYNTHETIC: 20 FLEURS-format rows written for this test (not FLEURS data).
const SYN_SENT = ["שלום עולם", "הפגישה נדחתה למחר", "קניתי לחם וחלב", "מזג האוויר נאה היום", "הרכבת יוצאת בשמונה"];
const synTsv = Array.from({ length: 20 }, (_, i) => [1000 + Math.floor(i / 2), `${10 + i}.wav`, SYN_SENT[i % 5] + (i % 3 ? "." : "!"), SYN_SENT[i % 5], "x", "16000", i % 2 ? "MALE" : "FEMALE"].join("\t")).join("\n");

describe("W11.H6 ASR adapters", () => {
  it("parses FLEURS' published TSV (7 columns, no header) with audio under <config>/audio/<split>/", () => {
    const items = parseFleursTsv(synTsv, "test", "data/he_il");
    expect(items).toHaveLength(20);
    expect(items[0]).toEqual({ id: "1000/10.wav", audio: "data/he_il/audio/test/10.wav", text: "שלום עולם!" });
    expect(() => parseFleursTsv("1\tfile.wav\tonly three", "test")).toThrow(/7 tab-separated/);
  });
  it("parses the export's audio-jsonl and rejects rows without text", () => {
    expect(parseAudioJsonl('{"id":1,"audio":"a.wav","text":"שלום"}\n')).toEqual([{ id: "1", audio: "a.wav", text: "שלום" }]);
    expect(() => parseAudioJsonl('{"id":1,"audio":"a.wav"}')).toThrow(/text/);
  });
  it("runs 20 clips through a stand-in engine and gives WER/CER under the leaderboard normaliser", async () => {
    const items = parseFleursTsv(synTsv, "test", "data/he_il");
    // Stand-in engine: echoes the reference, drops the last word on every 4th clip, fails on one.
    const byAudio = new Map(items.map((it, i) => [it.audio, { it, i }]));
    const engine: AsrEngine = {
      id: "stand-in",
      async transcribe(audio) {
        const { it, i } = byAudio.get(audio)!;
        if (i === 7) throw new Error("decoder crashed");
        return i % 4 === 0 ? it.text.split(" ").slice(0, -1).join(" ") : it.text.toUpperCase();
      },
    };
    const s = await scoreAsr(items, engine, normalizer("ivrit-leaderboard"));
    expect(s.n).toBe(20);
    expect(s.failed).toEqual(["1003/17.wav"]);
    const refWords = s.items.reduce((a, r) => a + r.refWords, 0);
    const edits = s.items.reduce((a, r) => a + r.wordEdits, 0);
    expect(edits).toBe(5 + s.items[7].refWords);
    expect(s.metrics.wer).toBeCloseTo(edits / refWords, 4);
    expect(s.metrics.cer).toBeGreaterThan(0);
  });
});

describe("W11.H9 TTS round trip (INSV-A) and the voice gate", () => {
  it("freezes the first N distinct sentence ids in numeric order and refuses a set that changed", () => {
    const items = parseFleursTsv(synTsv, "test");
    const f = freezePrompts(items, 10);
    expect(f.map((x) => x.id)).toEqual(Array.from({ length: 10 }, (_, i) => `${1000 + i}/${10 + 2 * i}.wav`));
    expect(() => freezePrompts(items, 11)).toThrow(/only 10 distinct/);
    expect(() => selectFrozen(items, ["9999/1.wav"])).toThrow(/not in the data/);
  });
  it("runs with a stand-in voice and judge and produces CER next to natural speech", async () => {
    const prompts = freezePrompts(parseFleursTsv(synTsv, "test"), 10);
    const voice = { id: "voice-stand-in", synthesize: async (t: string, id: string) => `synth:${id}:${t}` };
    // The stand-in judge "hears" synthetic audio with one character lost per clip; natural audio perfectly.
    const text = new Map(prompts.map((p) => [p.audio, p.text]));
    const judge: AsrEngine = { id: "judge-stand-in", transcribe: async (a) => (a.startsWith("synth:") ? a.split(":").slice(2).join(":").slice(1) : text.get(a)!) };
    const s = await scoreRoundTrip(prompts, voice, judge, normalizer("ivrit-leaderboard"));
    expect(s.n).toBe(10);
    expect(s.metrics.naturalCer).toBe(0);
    expect(s.metrics.cer).toBeGreaterThan(0);
    expect(s.metrics.cer).toBeLessThan(0.1);
  });
  it("blocks a voice above 6 % CER unless it is within 2 points of natural speech", () => {
    expect(voicePasses({ cer: 0.05, naturalCer: 0.01 })).toBe(true);
    expect(voicePasses({ cer: 0.06, naturalCer: 0.01 })).toBe(true);
    expect(voicePasses({ cer: 0.09, naturalCer: 0.01 })).toBe(false);
    expect(voicePasses({ cer: 0.09, naturalCer: 0.075 })).toBe(true);
    expect(voicePasses({ cer: Number.NaN, naturalCer: 0 })).toBe(false);
    expect(voicePasses(null)).toBe(false);
  });
});

// SYNTHETIC dotted lines written for this test (not the Nakdimon test set).
const NIKUD_SYN = ["שָׁלוֹם", "בַּיִת גָּדוֹל", "הַיֶּלֶד הָלַךְ", "סֵפֶר חָדָשׁ", "עִיר יָפָה", "מַיִם קָרִים", "שִׂמְחָה רַבָּה", "לֶחֶם טָרִי", "אִישׁ טוֹב", "דֶּלֶת פְּתוּחָה"];

describe("W11.H10 niqqud on the Nakdimon test-set format (DEC / CHA / WOR)", () => {
  const items = parseNakdimonTest({ "tests/syn/a.txt": NIKUD_SYN.slice(0, 5).join("\n"), "tests/syn/b.txt": NIKUD_SYN.slice(5).join("\n") + "\n\n" });
  it("reads one item per dotted line", () => {
    expect(items).toHaveLength(10);
    expect(items[0].id).toBe("tests/syn/a.txt#1");
    expect(undot("שָׁלוֹם")).toBe("שלום");
  });
  it("counts vowel, dagesh and shin/sin decisions per letter", () => {
    expect(compareNikud("שָׁלוֹם", "שָׁלוֹם")).toMatchObject({ aligned: true, wor: [1, 1], cha: [4, 4] });
    const sinWrong = compareNikud("שִׂמְחָה", "שִׁמְחָה");
    expect(sinWrong.cha).toEqual([3, 4]);
    expect(sinWrong.wor).toEqual([0, 1]);
    expect(compareNikud("בַּיִת", "בַיִת").dec[0]).toBe(compareNikud("בַּיִת", "בַּיִת").dec[0] - 1);
    expect(compareNikud("שָׁלוֹם", "שלומ").aligned).toBe(false);
  });
  it("runs 10 lines through a stand-in engine", async () => {
    const gold = new Map(items.map((i) => [undot(i.gold), i.gold]));
    // Stand-in: returns gold, except the sin dot of "שִׂמְחָה" becomes a shin dot.
    const engine = { id: "stand-in", dot: async (t: string) => gold.get(t)!.replace("שִׂ", "שִׁ") };
    const s = await scoreNikud(items, engine);
    expect(s.n).toBe(10);
    expect(s.misaligned).toEqual([]);
    expect(s.metrics.wor).toBeCloseTo(18 / 19, 4);
    expect(s.metrics.dec).toBeLessThan(1);
  });
});

describe("W11.H10 MILIM (G2P) and the ReNikud rule", () => {
  // SYNTHETIC rows in the assumed MILIM format.
  const rows = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `s${i}`, category: i < 5 ? "homograph" : "loanword", sentence: "הוא ספר ספר", targets: [{ index: 2, word: "ספר", ipa: i % 2 ? "ˈsefeʁ" : "safaʁ" }] })).join("\n");
  it("parses and checks every field", () => {
    expect(parseMilimJsonl(rows)).toHaveLength(10);
    expect(() => parseMilimJsonl('{"id":"x","category":"c","sentence":"א ב","targets":[{"index":5,"word":"ב","ipa":"b"}]}')).toThrow(/index/);
  });
  it("scores target words with a stand-in engine (stress ignored by default)", async () => {
    const engine = { id: "stand-in", phonemize: async () => ["hu", "safaʁ", "sefeʁ"] };
    const s = await scoreG2p(parseMilimJsonl(rows), engine);
    expect(s.targets).toBe(10);
    expect(s.metrics.wer).toBe(0.5);
    expect(s.byCategory.homograph.targets).toBe(5);
  });
  it("ReNikud needs a permissive licence and ≤ 0.8 × Phonikud's MILIM WER", () => {
    expect(renikudAllowed({ licenseAllowed: false, renikudWer: 0.1, phonikudWer: 0.4 })).toBe(false);
    expect(renikudAllowed({ licenseAllowed: true, renikudWer: 0.243, phonikudWer: 0.356 })).toBe(true);
    expect(renikudAllowed({ licenseAllowed: true, renikudWer: 0.3, phonikudWer: 0.356 })).toBe(false);
    expect(renikudAllowed({ licenseAllowed: true, renikudWer: null, phonikudWer: 0.356 })).toBe(false);
  });
});

describe("W11.H14 handwriting benchmark adapter and gate", () => {
  // SYNTHETIC: 5 lines written for this test, not the ivrit.ai benchmark.
  const lines = ["שלום לכולם", "היום יום יפה", "נפגש מחר בבוקר", "תודה רבה", "להתראות"].map((t, i) => JSON.stringify({ id: `l${i}`, writer: `w${i % 2}`, image: `i${i}.png`, text: t })).join("\n");
  it("parses the export and measures word coverage as a multiset", () => {
    expect(parseImageJsonl(lines)).toHaveLength(5);
    expect(wordCoverage("יום יום טוב", "יום טוב")).toEqual({ hit: 2, total: 3 });
  });
  it("runs 5 lines through a stand-in engine", async () => {
    const items = parseImageJsonl(lines);
    const byImage = new Map(items.map((i) => [i.image, i.text]));
    const engine = { id: "stand-in", recognize: async (img: string) => (img === "i0.png" ? "שלום לכלם" : byImage.get(img)!) };
    const s = await scoreHandwriting(items, engine);
    expect(s).toMatchObject({ n: 5, writers: 2 });
    expect(s.metrics.wordCoverage).toBeCloseTo(10 / 11, 4);
    expect(s.metrics.medianCer).toBe(0);
    expect(s.metrics.microCer).toBeGreaterThan(0);
  });
  it("hides the capability when the median CER is above 20 %", () => {
    expect(handwritingExposed({ medianCer: 0.25 })).toBe(false);
    expect(handwritingExposed({ medianCer: 0.2 })).toBe(true);
    expect(handwritingExposed(null)).toBe(false);
  });
});
