#!/usr/bin/env node
/**
 * Arabic spelling recall (plan W5.17): `node scripts/eval-arabic-spell.mjs <index.dic>`.
 *
 * Ayaspell's word list is not in the repo (GPL / LGPL / MPL, downloaded by
 * the user in the app), so this eval takes its path: download it once with
 *   curl -L -o /tmp/ar.dic https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/ar/index.dic
 * It runs the app's own checker (src/ai/arabicSpell.ts, transpiled with the
 * repo's typescript) on eval/arabic-spell/errors.json: 200 misspellings of
 * 100 common words. It prints the recall (wrong forms flagged) and the false
 * alarms (right forms flagged), and exits 1 below the 70 % recall target.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadChecker() {
  const dir = mkdtempSync(join(tmpdir(), "lumen-ar-spell-"));
  try {
    const files = { "arabicSpell.mjs": "src/ai/arabicSpell.ts", "arabic.mjs": "src/text/arabic.ts" };
    for (const [out, src] of Object.entries(files)) {
      const code = readFileSync(join(ROOT, src), "utf8").replace(/from "\.\.\/text\/arabic"/, 'from "./arabic.mjs"');
      writeFileSync(join(dir, out), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    }
    return await import(pathToFileURL(join(dir, "arabicSpell.mjs")).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dicPath = process.argv[2];
if (!dicPath) {
  console.error("usage: node scripts/eval-arabic-spell.mjs <path to Ayaspell index.dic>");
  process.exit(2);
}
const { buildArabicDictionary, isKnownArabic } = await loadChecker();
const dict = buildArabicDictionary(readFileSync(dicPath, "utf8"));
const { items, target } = JSON.parse(readFileSync(join(ROOT, "eval/arabic-spell/errors.json"), "utf8"));
const flagged = items.filter((it) => !isKnownArabic(dict, it.wrong));
const rights = [...new Set(items.map((it) => it.right))];
const falseAlarms = rights.filter((w) => !isKnownArabic(dict, w));
const recall = flagged.length / items.length;
const byKind = {};
for (const it of items) {
  byKind[it.kind] ??= { n: 0, flagged: 0 };
  byKind[it.kind].n++;
  if (!isKnownArabic(dict, it.wrong)) byKind[it.kind].flagged++;
}
console.log(JSON.stringify({ stems: dict.size, items: items.length, recall: Number(recall.toFixed(3)), byKind, falseAlarms: falseAlarms.length, falseAlarmWords: falseAlarms }, null, 2));
if (recall < target.recall) {
  console.error(`recall ${recall.toFixed(3)} is below the target ${target.recall}`);
  process.exit(1);
}
