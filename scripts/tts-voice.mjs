#!/usr/bin/env node
/**
 * A neural Hebrew voice for read-aloud (plan W2.6), owner side: everything
 * but the voice is built, and this checks a candidate before it is listed.
 *
 *   npm run tts:voice -- check <voice.onnx.json>
 *        does the Piper config cover every phoneme Lumen's G2P writes, and the pauses?
 *   npm run tts:voice -- pin --id <id> --model <voice.onnx> --config <voice.onnx.json>
 *        --model-url <https://…/resolve/<sha>/…> --config-url <…> --license <weights> --data-license <training data>
 *        --attribution "<text>" [--source <url>] [--speaker <n>]
 *        checks the config, the licences (decision 15.10: no non-commercial, no GPL, nothing on the
 *        registry's deny-list) and the URLs, then prints the HEBREW_VOICES entry for
 *        src/ai/tts/voices.ts and the models/registry.json entry, with sizes and sha256 of these files.
 *
 * Exit 0 when it can be listed, 1 with the reasons when not, 2 on a usage error.
 */
import { readFileSync, statSync } from "node:fs";
import { configProblems, isPinnedUrl, licenceProblems, registryEntry, sha256, voiceSnippet } from "./lib/tts-voice.mjs";

const { G2P_PHONEMES } = await import("../src/ai/tts/hebrewG2P.ts");
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "help";
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (problems) => {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
};
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`cannot read ${f}: ${e.message}`);
    process.exit(2);
  }
};

if (cmd === "check") {
  const file = args[1];
  if (!file) {
    console.error("usage: npm run tts:voice -- check <voice.onnx.json>");
    process.exit(2);
  }
  const config = readJson(file);
  const problems = configProblems(config, G2P_PHONEMES);
  if (problems.length) fail(problems);
  console.log(`✓ ${file}: ${G2P_PHONEMES.length} phonemes and the pauses covered, ${config.audio.sample_rate} Hz${config.num_speakers > 1 ? `, ${config.num_speakers} speakers` : ""}`);
  process.exit(0);
}

if (cmd === "pin") {
  const v = { id: flag("--id"), modelUrl: flag("--model-url"), configUrl: flag("--config-url"), license: flag("--license"), dataLicense: flag("--data-license"), attribution: flag("--attribution"), source: flag("--source"), speaker: flag("--speaker") };
  const model = flag("--model");
  const configFile = flag("--config");
  if (!v.id || !model || !configFile) {
    console.error("usage: npm run tts:voice -- pin --id <id> --model <voice.onnx> --config <voice.onnx.json> --model-url … --config-url … --license … --data-license … --attribution …");
    process.exit(2);
  }
  const problems = [];
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(v.id)) problems.push("the id is 3–64 lowercase letters, digits, dots, dashes or underscores");
  problems.push(...configProblems(readJson(configFile), G2P_PHONEMES));
  for (const [n, u] of [["--model-url", v.modelUrl], ["--config-url", v.configUrl]]) if (!isPinnedUrl(u)) problems.push(`${n} must be https and name a fixed revision (…/resolve/<40-hex sha>/…, a release download, or …/raw/<sha>/…)`);
  if (v.speaker !== undefined && !/^\d+$/.test(v.speaker)) problems.push("--speaker is a whole number");
  problems.push(...licenceProblems(v, readJson(new URL("../models/registry.json", import.meta.url))));
  if (problems.length) fail(problems);
  const files = {
    model: { bytes: statSync(model).size, sha256: sha256(readFileSync(model)) },
    config: { bytes: statSync(configFile).size, sha256: sha256(readFileSync(configFile)) },
  };
  if (files.model.bytes < 1024) fail([`${model} is ${files.model.bytes} bytes: not a voice model`]);
  console.log(`Add to HEBREW_VOICES in src/ai/tts/voices.ts:\n\n${voiceSnippet(v, files)}\n`);
  console.log(`Add to "models" in models/registry.json (verified: true only after reading both licences):\n\n${JSON.stringify(registryEntry(v, files), null, 2)}\n`);
  console.log(`Then: npm run tts:mos -- sheet --raters <5 names>, read the 20 sentences with this voice, and score them (target MOS ≥ 3.8).`);
  process.exit(0);
}

console.log("usage: npm run tts:voice -- check <voice.onnx.json> | pin --id … --model … --config … --model-url … --config-url … --license … --data-license … --attribution …");
process.exit(cmd === "help" ? 0 : 2);
