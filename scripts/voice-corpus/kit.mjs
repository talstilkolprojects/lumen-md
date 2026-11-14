#!/usr/bin/env node
/**
 * The Hebrew voice corpus kit (plan W7.10), the command-line half:
 *
 *   npx tsx scripts/voice-corpus/kit.mjs script <pool.txt …> [--count 1500] > script.tsv
 *       The recording script: one sentence per line from CC0 / public-domain
 *       pools (Common Voice's Hebrew sentences, Project Ben-Yehuda via W7.7),
 *       only readable Hebrew, chosen for letter-bigram coverage.
 *   npx tsx scripts/voice-corpus/kit.mjs check <dir with wavs/ and script.tsv> [--out corpus/]
 *       Checks every take (level, clipping, noise, silence around the speech),
 *       and writes the LJSpeech layout piper_train.preprocess reads:
 *       corpus/metadata.csv (passing takes only) and corpus/wavs/.
 *   npx tsx scripts/voice-corpus/kit.mjs mos <ratings.csv>
 *       The listening test: rater,sentence,score,wrongWords,words → MOS,
 *       pronunciation errors, pass (≥ 10 raters, 30 sentences, MOS ≥ 3.5, ≤ 5%).
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildScript, checkTake, listeningResult, ljspeechMetadata, summary } from "../../src/voice-corpus/corpus.ts";

const flag = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);

/** 16-bit PCM mono WAV → samples (the recorder writes exactly this). */
export function readWav(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== "RIFF") throw new Error("not a WAV file");
  let off = 12;
  let rate = 0;
  let channels = 1;
  while (off + 8 <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(off, off + 4));
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
      if (v.getUint16(off + 22, true) !== 16) throw new Error("only 16-bit PCM");
    } else if (id === "data") {
      const n = Math.floor(size / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(off + 8 + i * 2 * channels, true) / 32768;
      return { samples: out, rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "script") {
  const files = rest.filter((a) => !a.startsWith("--") && a !== flag("--count"));
  const pool = files.flatMap((f) => readFileSync(f, "utf8").split(/\r?\n/).map((text) => ({ text, source: basename(f) })));
  const s = buildScript(pool, { count: Number(flag("--count", "1500")) });
  process.stdout.write(s.map((x) => `${x.id}\t${x.text}\t${x.source}`).join("\n") + "\n");
  console.error(`script: ${s.length} sentences from ${pool.length} candidates`);
} else if (cmd === "check") {
  const dir = rest[0];
  const out = flag("--out", join(dir, "corpus"));
  const script = new Map(readFileSync(join(dir, "script.tsv"), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")).map(([id, text]) => [id, text]));
  mkdirSync(join(out, "wavs"), { recursive: true });
  const takes = [];
  for (const f of readdirSync(join(dir, "wavs")).filter((f) => f.endsWith(".wav")).sort()) {
    const id = f.replace(/\.wav$/, "");
    const { samples, rate } = readWav(readFileSync(join(dir, "wavs", f)));
    const c = checkTake(samples, rate);
    const ok = c.ok && script.has(id);
    takes.push({ id, text: script.get(id) ?? "", ok, seconds: samples.length / rate, problems: c.problems });
    if (ok) copyFileSync(join(dir, "wavs", f), join(out, "wavs", f));
  }
  writeFileSync(join(out, "metadata.csv"), ljspeechMetadata(takes));
  writeFileSync(join(out, "takes.json"), JSON.stringify(takes, null, 1) + "\n");
  const s = summary(takes);
  console.log(`check: ${s.ok}/${s.takes} takes pass, ${s.hours.toFixed(2)} h of good audio (${s.enough ? "enough" : "need 2 h"})`);
} else if (cmd === "mos") {
  const rows = readFileSync(rest[0], "utf8").split("\n").slice(1).filter(Boolean).map((l) => l.split(","));
  const r = listeningResult(rows.map(([rater, sentence, score, wrongWords, words]) => ({ rater, sentence, score: Number(score), wrongWords: Number(wrongWords), words: Number(words) })));
  console.log(`listening test: ${r.raters} raters, ${r.sentences} sentences, MOS ${r.mos.toFixed(2)} ± ${r.ci95.toFixed(2)}, mispronounced ${(r.wrongWordRate * 100).toFixed(1)}% → ${r.pass ? "PASS" : "FAIL"}`);
  process.exit(r.pass ? 0 : 1);
} else if (process.argv[1]?.endsWith("kit.mjs")) {
  console.error("usage: kit.mjs script <pool…> | check <dir> | mos <ratings.csv>");
  process.exit(2);
}
