#!/usr/bin/env node
/**
 * Desktop Whisper (plan W1.17) — owner tools.
 *
 *   npm run whisper:desktop -- pin
 *        prints the commands that find the ivrit.ai ggml file's repository,
 *        revision, size and sha256 on Hugging Face
 *   npm run whisper:desktop -- pin --repo <owner/name> --revision <sha> --file <name.bin> --bytes <n> --sha256 <hex>
 *        checks the values and prints the WHISPER_GGML block to paste into
 *        src/ai/dictation/whisperDesktop.ts
 *   npm run whisper:desktop -- wer --split test=<dir> --model <ggml.bin> [--cli whisper-cli] [--out whisper-desktop-scores.json]
 *        WER / CER on the asr-he clips (FLEURS-he test, Common Voice) with
 *        the 6.1 normalisation, plus speed (real-time factor, minutes per
 *        hour of audio). Only numbers are printed, never a transcript.
 *
 * Needs ffmpeg and whisper-cli for `wer`. Runs offline once the model is on disk.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";

const APP_ID = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).identifier;
import { parseSrt, pinSnippet, speedReport, validatePin } from "./lib/whisper-desktop.mjs";

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "help";
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

if (cmd === "pin") {
  if (!flag("--repo")) {
    console.log(`Find the ggml file (on a machine with Hugging Face access):

  # ivrit.ai repositories that publish ggml / whisper.cpp files
  curl -s "https://huggingface.co/api/models?author=ivrit-ai&search=ggml" | jq -r '.[].id'
  curl -s "https://huggingface.co/api/models?author=ivrit-ai&search=whisper.cpp" | jq -r '.[].id'

  # the repo's current commit, its licence tag, and the .bin files with size + sha256
  R=<repo from above>
  curl -s "https://huggingface.co/api/models/$R" | jq -r '.sha, (.tags[] | select(startswith("license:")))'
  SHA=<sha from above>
  curl -s "https://huggingface.co/api/models/$R/tree/$SHA" | jq -r '.[] | select(.path | endswith(".bin")) | "\\(.path) \\(.lfs.size) \\(.lfs.oid)"'

Then: npm run whisper:desktop -- pin --repo $R --revision $SHA --file <file> --bytes <size> --sha256 <oid>`);
    process.exit(0);
  }
  const pin = { repo: flag("--repo"), revision: flag("--revision"), file: flag("--file"), bytes: Number(flag("--bytes")), sha256: flag("--sha256") };
  const problems = validatePin(pin);
  if (problems.length) {
    console.error(`✗ ${problems.join("\n✗ ")}`);
    process.exit(1);
  }
  console.log(`Paste into src/ai/dictation/whisperDesktop.ts:\n\n${pinSnippet(pin)}\n`);
  const dir = `$HOME/Library/Application Support/${APP_ID}/whisper`;
  console.log(`Install it for the desktop app (macOS; Windows: %APPDATA%\\${APP_ID}\\whisper\\, Linux: ~/.local/share/${APP_ID}/whisper/):\n`);
  console.log(`  brew install whisper-cpp   # provides whisper-cli (MIT); or build ggml-org/whisper.cpp`);
  console.log(`  mkdir -p "${dir}"`);
  console.log(`  curl -L -o "${dir}/${pin.file}" "https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${pin.file}"`);
  console.log(`  shasum -a 256 "${dir}/${pin.file}"   # must print ${pin.sha256}`);
  console.log(`\nAnd set the registry entry ivrit-ai/whisper-large-v3-turbo's size to ${pin.bytes} bytes (${pin.repo}@${pin.revision.slice(0, 12)}).`);
  process.exit(0);
}

if (cmd === "wer") {
  const splits = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--split") splits.push(args[++i].split("="));
  const model = flag("--model");
  const cli = flag("--cli") ?? "whisper-cli";
  const outFile = flag("--out") ?? "whisper-desktop-scores.json";
  if (!splits.length || !model || !existsSync(model)) {
    console.error("usage: npm run whisper:desktop -- wer --split test=<dir> --model <ggml.bin> [--cli whisper-cli] [--out file]");
    process.exit(1);
  }
  const { errors, rates } = await import("./golden/evals/asr-he.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "lumen-whisper-wer-"));
  const threads = String(Math.max(1, cpus().length));
  const report = { engine: `whisper.cpp (${cli}) · ${model.split(/[\\/]/).pop()} · language he forced`, splits: {} };
  try {
    for (const [name, dir] of splits) {
      const items = [];
      for (const part of ["fleurs", "common-voice"]) {
        const f = join(dir, `${part}.json`);
        if (existsSync(f)) for (const it of JSON.parse(readFileSync(f, "utf8")).items) items.push({ ...it, part, audio: join(dir, it.audio) });
      }
      if (!items.length) {
        report.splits[name] = { status: "not-built" };
        continue;
      }
      const byPart = new Map();
      let computeMs = 0;
      let audioMs = 0;
      for (const [i, it] of items.entries()) {
        const wav = join(tmp, `${i}.wav`);
        const ff = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", it.audio, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
        if (ff.status !== 0) throw new Error(`ffmpeg could not decode clip ${i}`);
        audioMs += ((readFileSync(wav).length - 44) / 32_000) * 1000;
        const t0 = performance.now();
        const r = spawnSync(cli, ["-m", model, "-f", wav, "-l", "he", "-osrt", "-of", join(tmp, `${i}`), "-np", "-t", threads], { encoding: "utf8" });
        computeMs += performance.now() - t0;
        if (r.status !== 0) throw new Error(`whisper-cli failed on clip ${i} (exit ${r.status})`);
        const hyp = parseSrt(readFileSync(join(tmp, `${i}.srt`), "utf8")).map((s) => s.text).join(" ");
        if (!byPart.has(it.part)) byPart.set(it.part, []);
        byPart.get(it.part).push(errors(it.text, hyp));
      }
      const scores = {};
      const all = [];
      for (const [part, list] of byPart) {
        const r = rates(list);
        scores[`wer.${part}`] = Math.round(r.wer * 1000) / 1000;
        scores[`cer.${part}`] = Math.round(r.cer * 1000) / 1000;
        scores[`items.${part}`] = list.length;
        all.push(...list);
      }
      const r = rates(all);
      report.splits[name] = { ...scores, wer: Math.round(r.wer * 1000) / 1000, cer: Math.round(r.cer * 1000) / 1000, items: all.length, ...speedReport(computeMs, audioMs) };
      const s = report.splits[name];
      console.log(`${name}: WER ${(s.wer * 100).toFixed(1)}% (FLEURS ${s["wer.fleurs"] === undefined ? "—" : (s["wer.fleurs"] * 100).toFixed(1) + "%"}) · CER ${(s.cer * 100).toFixed(1)}% · ${s.items} clips · RTF ${s.rtf} → ${s.minutesPerHour} min per hour of audio${s.underTarget ? " ✓" : " ✗ (target < 10)"}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`written: ${outFile}`);
  process.exit(0);
}

console.log("usage: npm run whisper:desktop -- pin [--repo … --revision … --file … --bytes … --sha256 …] | wer --split test=<dir> --model <ggml.bin>");
process.exit(cmd === "help" ? 0 : 1);
