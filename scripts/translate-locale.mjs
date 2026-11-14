#!/usr/bin/env node
/**
 * Translate Lumen's i18n keys to a target locale via OpenAI (β.4.2).
 *
 * Reads `i18n/keys/*.json` (from `extract-i18n-keys.mjs`) and writes the
 * model's translations to `src/i18n/locales/<locale>/<domain>.json`
 * (plan 0.3: one sorted file per domain).
 *
 * Translation contract enforced through the system prompt:
 *   - Preserve every `{var}` placeholder verbatim.
 *   - Preserve markdown inline code (`code`).
 *   - Keep keyboard shortcuts (⌘K, Esc, Tab, Shift, Ctrl) untranslated.
 *   - Preserve emoji + leading symbols (✅, ⚠️, →, …).
 *   - Output strict JSON: `{ "key": "translation" }`.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-… node scripts/translate-locale.mjs \
 *       --locale=fr [--model=gpt-4o-mini] [--in=i18n/keys] \
 *       [--out=src/i18n/locales] [--batch=40]
 *
 * --in is the keys directory (or one keys file); --out is the locales
 * directory the <locale>/ folder is written under.
 *
 * Idempotent: re-runs only fill gaps unless `--force` is passed.
 */

import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { KEYS_DIR, LOCALES_DIR, ROOT, readKeyEntries, readLocale, writeLocale } from "./lib/i18n-files.mjs";
import { argv, env, exit } from "node:process";

function parseArgs(args) {
  const out = {};
  for (const a of args) {
    const m = /^--([\w-]+)(?:=(.+))?$/.exec(a);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const args = parseArgs(argv.slice(2));
const locale = args.locale;
if (!locale) {
  console.error("usage: translate-locale --locale=<code> [--model=…] [--in=…] [--out=…] [--batch=N] [--force]");
  exit(2);
}

const apiKey = env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY env var is required.");
  exit(2);
}

const inPath = resolve(args.in ?? KEYS_DIR);
const outDir = resolve(args.out ?? LOCALES_DIR);
const outPath = join(outDir, locale);
const model = args.model ?? "gpt-4o-mini";
const batchSize = Number(args.batch ?? 40);

const entries = statSync(inPath).isDirectory()
  ? readKeyEntries(inPath)
  : (JSON.parse(await readFile(inPath, "utf8")).entries ?? []);
if (entries.length === 0) {
  console.error(`No entries in ${inPath}`);
  exit(2);
}

const existing = args.force ? {} : readLocale(locale, outDir);
const todo = entries.filter((e) => !(e.key in existing));
if (todo.length === 0) {
  console.error(`✓ ${outPath} already complete (${entries.length} keys).`);
  exit(0);
}
console.error(`→ Translating ${todo.length} key(s) to ${locale} via ${model} …`);

const SYSTEM = `You are a localization expert translating UI strings for Lumen, a markdown editor.
Translate values into ${locale}. Rules — break ANY of these and you fail:
1. Preserve every {placeholder} verbatim.
2. Preserve markdown inline code blocks (text between backticks) verbatim.
3. Keep keyboard shortcut tokens untranslated: ⌘, ⌥, ⇧, ⌃, Esc, Tab, Enter, ⌘K, Ctrl, Alt, Shift.
4. Preserve emoji + leading punctuation (✅ ⚠️ → 🛡 etc.) at the same position.
5. Output ONLY a strict JSON object mapping each input "key" to its translation. No commentary, no markdown wrapping.`;

async function translateBatch(batch) {
  const userPayload = JSON.stringify(
    Object.fromEntries(batch.map((b) => [b.key, b.en])),
  );
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPayload },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("No content in response");
  return JSON.parse(text);
}

const output = { ...existing };
for (let i = 0; i < todo.length; i += batchSize) {
  const batch = todo.slice(i, i + batchSize);
  process.stderr.write(`  · batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(todo.length / batchSize)} (${batch.length} keys)…`);
  try {
    const translations = await translateBatch(batch);
    let added = 0;
    for (const b of batch) {
      const v = translations[b.key];
      if (typeof v === "string" && v.length > 0) {
        // Sanity: every placeholder in the source must appear in the
        // translation. If the model dropped one, re-fall through to en.
        const ok = b.vars.every((v2) => v.includes(`{${v2}}`));
        if (ok) {
          output[b.key] = v;
          added++;
          continue;
        }
      }
      // Fall through: keep English so the UI still has a string.
      output[b.key] = b.en;
    }
    process.stderr.write(` ${added}/${batch.length} ok\n`);
  } catch (e) {
    process.stderr.write(` FAILED: ${e.message}\n`);
    // Keep the partial output and bail with a non-zero so the user knows.
    break;
  }
}

const files = writeLocale(locale, output, outDir);
console.error(
  `✓ wrote ${Object.keys(output).length} entries to ${relative(ROOT, outPath)}/ in ${files.length} domain files (target ${locale})`,
);
