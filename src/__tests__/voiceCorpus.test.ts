/**
 * Plan W7.10: the CC0 Hebrew voice corpus kit — the script, the take check,
 * the LJSpeech export Piper reads, and the listening-test arithmetic.
 */
import { describe, expect, it } from "vitest";
import { bigrams, buildScript, checkTake, licenceOk, listeningResult, ljspeechMetadata, readable, rtf, summary, wav, type Rating } from "../voice-corpus/corpus";
import { readWav } from "../../scripts/voice-corpus/kit.mjs";

const RATE = 22050;
/** A take: silence (with faint noise), a tone at `amp` for `speech` seconds, silence. */
function take(amp: number, speech = 2, lead = 0.4, noise = 0.0005, seed = 1): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const n = Math.round((lead * 2 + speech) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const voiced = t >= lead && t < lead + speech;
    out[i] = (voiced ? amp * Math.sin(2 * Math.PI * 180 * t) : 0) + noise * rnd();
  }
  return out;
}

describe("Hebrew voice corpus kit (W7.10)", () => {
  it("only sentences a speaker can read without guessing", () => {
    expect(readable("הילד הלך אל הגן עם אמו")).toBe(true);
    expect(readable("בשנת 1948 קמה המדינה")).toBe(false);
    expect(readable("שלחו את זה ל-Dana מחר")).toBe(false);
    expect(readable("קצר מדי")).toBe(false);
    expect(readable("הָיֹה הָיָה מֶלֶךְ אֶחָד בְּאֶרֶץ רְחוֹקָה")).toBe(true);
  });

  it("the script covers letter bigrams greedily, drops duplicates, and is stable", () => {
    const pool = ["הילד הלך אל הגן עם אמו", "הילד הלך אל הגן עם אמו", "צפרדע קפצה מעל הגדר הישנה", "הילד הלך אל הגן עם אביו", "שמש חמה זורחת על ההרים"].map((text, i) => ({ text, source: `p${i}` }));
    const s = buildScript(pool, { count: 3 });
    expect(s.map((x) => x.id)).toEqual(["he_0001", "he_0002", "he_0003"]);
    expect(new Set(s.map((x) => x.text)).size).toBe(3);
    expect(buildScript(pool, { count: 3 })).toEqual(s);
    expect(bigrams("אם").has("^א")).toBe(true);
    expect(bigrams("אם").has("ם$")).toBe(true);
  });

  it("a clean take passes; clipping, a quiet or noisy take, and no silence around the speech are caught", () => {
    expect(checkTake(take(0.3), RATE)).toMatchObject({ ok: true, problems: [] });
    expect(checkTake(take(1.2), RATE).problems).toContain("clipping");
    expect(checkTake(take(0.01), RATE).problems).toContain("too-quiet");
    expect(checkTake(take(0.3, 2, 0.4, 0.05), RATE).problems).toContain("noisy");
    expect(checkTake(take(0.3, 2, 0.02), RATE).problems).toEqual(expect.arrayContaining(["no-lead", "no-tail"]));
  });

  it("a take is written as 16-bit mono WAV and read back by the kit", () => {
    const t = take(0.3, 0.5);
    const r = readWav(wav(t, RATE));
    expect(r.rate).toBe(RATE);
    expect(r.samples.length).toBe(t.length);
    expect(Math.max(...Array.from(r.samples.slice(9000, 9100), (x, i) => Math.abs(x - t[9000 + i])))).toBeLessThan(1 / 16000);
  });

  it("the LJSpeech metadata Piper reads has only passing takes; two hours is the bar", () => {
    expect(ljspeechMetadata([{ id: "he_0001", text: "שלום עולם", ok: true }, { id: "he_0002", text: "x", ok: false }])).toBe("he_0001|שלום עולם|שלום עולם\n");
    expect(summary(Array.from({ length: 1500 }, () => ({ ok: true, seconds: 5 })))).toMatchObject({ ok: 1500, enough: true });
    expect(summary([{ ok: true, seconds: 3600 }, { ok: false, seconds: 9999 }]).enough).toBe(false);
  });

  it("the listening test: 10 raters × 30 sentences, MOS ≥ 3.5 and ≤ 5% mispronounced words to pass", () => {
    const ratings = (score: number, wrong: number): Rating[] => Array.from({ length: 300 }, (_, i) => ({ rater: `r${i % 10}`, sentence: `s${Math.floor(i / 10)}`, score, wrongWords: wrong, words: 10 }));
    expect(listeningResult(ratings(4, 0))).toMatchObject({ raters: 10, sentences: 30, mos: 4, pass: true });
    expect(listeningResult(ratings(4, 1)).pass).toBe(false); // 10% of words
    expect(listeningResult(ratings(3, 0)).pass).toBe(false);
    expect(listeningResult(ratings(4, 0).slice(0, 290)).pass).toBe(false); // 29 sentences
    expect(rtf(500, RATE * 2, RATE)).toBe(0.25);
    expect([licenceOk("CC0-1.0"), licenceOk("MIT"), licenceOk("CC-BY-NC-4.0")]).toEqual([true, true, false]);
  });
});
