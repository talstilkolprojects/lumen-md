#!/usr/bin/env node
/**
 * Diagnostics for the plan 6.1 engine: on a few PUBLIC clips (the FLEURS
 * validation sample, never the held-out test), when each engine emits each
 * token and what timestamp it gives it — Lumen's port vs sherpa-onnx.
 *
 *   node scripts/asr/compare.mjs DIR [N]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRecognizer, decodeAudio } from "../golden/evals/asr-he.mjs";

const [dir, n = "2"] = process.argv.slice(2);
if (/test/.test(dir)) throw new Error("compare.mjs is for public clips only");
const items = JSON.parse(readFileSync(join(dir, "fleurs.json"), "utf8")).items.slice(0, Number(n));
const meta = await import("../../src/ai/dictation/onnxMeta.ts").catch(() => null);
if (meta) {
  const m = meta.onnxMetadata(new Uint8Array(readFileSync(join(process.env.LUMEN_ASR_MODEL_DIR, "encoder.int8.onnx"))));
  console.log(`::notice title=asr encoder metadata::${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}
for (const engine of ["sherpa", "lumen"]) {
  const rec = await createRecognizer(undefined, engine);
  for (const it of items) {
    const samples = decodeAudio(join(dir, it.audio));
    const s = rec.createStream();
    const rows = [];
    let seen = 0;
    const step = 2560;
    for (let at = 0; at < samples.length; at += step) {
      s.acceptWaveform(samples.subarray(at, at + step));
      let chunks = 0;
      while (rec.isReady(s)) {
        await rec.decode(s);
        chunks++;
      }
      const r = rec.getResult(s);
      for (let i = seen; i < r.tokens.length; i++) rows.push(`${r.tokens[i]}@${r.timestamps[i].toFixed(2)}/fed${((at + step) / 16000).toFixed(2)}`);
      if (chunks) rows.push(`[${chunks}ch@${((at + step) / 16000).toFixed(2)}]`);
      seen = r.tokens.length;
    }
    console.log(`::notice title=asr ${engine} ${it.id} timing::${rows.slice(0, 60).join(" ")}`);
  }
}
