#!/usr/bin/env node
/**
 * Plan W5.20 — voice commands on recordings: each clip through the
 * dictation model (Zipformer2 streaming, as in the browser — the asr-he
 * harness) and the intent grammar (src/ai/voice/intents.ts). Target:
 * ≥ 90 % right on 200 recorded commands from different speakers, 0 network
 * requests (the model is local; this script makes none).
 *
 *   npm run eval:voice-commands -- --script                  # the 200 sentences to read aloud, as commands.json to fill in
 *   npm run eval:voice-commands -- --dir <recordings> [--out voice-commands.json]
 *
 * <recordings>/commands.json: { "items": [{ "audio": "a01.wav", "intent": "new-note", "slot"?: "…", "speaker"?: "A" }] }
 * Needs LUMEN_ASR_MODEL_DIR (scripts/asr/fetch-model.sh) and ffmpeg.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const { parseIntent } = await import("../src/ai/voice/intents.ts");

if (args.includes("--script")) {
  const { SPOKEN_COMMANDS } = await import("../src/ai/voice/commandCorpus.ts");
  const items = SPOKEN_COMMANDS.map((c, i) => ({ audio: `c${String(i + 1).padStart(3, "0")}.wav`, text: c.text, intent: c.intent, ...(c.slot ? { slot: c.slot } : {}), speaker: "" }));
  process.stdout.write(JSON.stringify({ items }, null, 2) + "\n");
  process.exit(0);
}
const dir = opt("--dir");
if (!dir) {
  console.error("usage: npm run eval:voice-commands -- --dir <recordings> [--out file]  |  -- --script");
  process.exit(2);
}
const { createRecognizer, decodeAudio, transcribeLive } = await import("./golden/evals/asr-he.mjs");
const recognizer = await createRecognizer();
const { items } = JSON.parse(readFileSync(join(dir, "commands.json"), "utf8"));
const rows = [];
for (const it of items) {
  const out = await transcribeLive(recognizer, decodeAudio(join(dir, it.audio)));
  const got = parseIntent(out.text);
  rows.push({ audio: it.audio, speaker: it.speaker ?? "", intent: it.intent, got: got?.id ?? null, ok: got?.id === it.intent, slotOk: !it.slot || got?.slot === it.slot });
}
const ok = rows.filter((r) => r.ok).length;
const bySpeaker = {};
for (const r of rows) {
  const s = (bySpeaker[r.speaker || "?"] ??= { ok: 0, total: 0 });
  s.total++;
  if (r.ok) s.ok++;
}
const report = { plan: "W5.20", engine: "ivrit-ai/zipformer2-66m-streaming-he + src/ai/voice/intents.ts", total: rows.length, ok, share: rows.length ? ok / rows.length : 0, slotOk: rows.filter((r) => r.ok && r.slotOk).length, bySpeaker, networkRequests: 0, rows: rows.map(({ audio, intent, got, ok: k }) => ({ audio, intent, got, ok: k })) };
writeFileSync(opt("--out") ?? "voice-commands.json", JSON.stringify(report, null, 2) + "\n");
console.log(`voice commands: ${ok}/${rows.length} (${(report.share * 100).toFixed(1)} %) — target ≥ 90 %; speakers: ${Object.entries(bySpeaker).map(([s, v]) => `${s} ${v.ok}/${v.total}`).join(", ")}`);
process.exit(report.share >= 0.9 ? 0 : 1);
