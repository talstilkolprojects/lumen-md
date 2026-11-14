/**
 * Pure helpers of the real-tiny-model run (plan 7.2), shared by
 * scripts/real-tiny-model.mjs and src/__tests__/realTinyModel.test.ts.
 *
 * - The model's digest (7.2.3): Ollama keeps every model by its content
 *   digest, so the run prints and records the digest it used, and a pinned
 *   digest (`--digest` / LUMEN_REAL_MODEL_DIGEST) makes the run refuse a
 *   different build of the same name.
 * - The Hebrew smoke test (7.2.2): DictaLM 3.0 1.7B answers a few short
 *   Hebrew prompts; each answer must be non-empty and mostly Hebrew, and the
 *   factual ones must name the expected word. A smoke test, not a quality
 *   score: the quality comparison is `npm run dictalm3 -- eval`.
 */

/** The DictaLM 3.0 1.7B build Lumen's catalogue names (src/ai/modelCatalog.ts). */
export const HEBREW_SMOKE_MODEL = "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF";

/** Short Hebrew prompts. `anyOf`: at least one of these words must appear. */
export const HEBREW_SMOKE_PROMPTS = [
  { id: "he-capital", prompt: "מהי בירת צרפת? ענה במילה אחת בעברית.", anyOf: ["פריז", "פאריז"] },
  { id: "he-sentence", prompt: "כתוב משפט אחד בעברית על מזג האוויר היום." },
  { id: "he-sum", prompt: "כמה זה שתיים ועוד שלוש? ענה במילה אחת בעברית.", anyOf: ["חמש", "חמישה", "5"] },
];

/** The smallest share of Hebrew letters (among all letters) an answer needs. */
export const MIN_HEBREW_SHARE = 0.6;

/** The model's entry in Ollama's /api/tags answer (with or without ":latest"). */
export function findModel(tags, model) {
  const models = (tags && tags.models) || [];
  return models.find((m) => m.name === model || m.model === model || m.name === `${model}:latest`) || null;
}

/** "sha256:…" normalised, so a pin may be given with or without the prefix. */
export function normalizeDigest(digest) {
  const d = String(digest || "").trim().toLowerCase();
  if (!d) return "";
  return d.startsWith("sha256:") ? d : `sha256:${d}`;
}

/**
 * The digest check: `null` when the run may go on, otherwise the reason to
 * stop. No pin: always fine (the digest is still printed and recorded).
 */
export function digestMismatch(entry, pinned) {
  const want = normalizeDigest(pinned);
  if (!want) return null;
  const have = normalizeDigest(entry && entry.digest);
  if (!have) return `the pinned digest is ${want}, but Ollama reported no digest for the model.`;
  return have === want ? null : `the pinned digest is ${want}, but the local model is ${have}. Pull the pinned build or update the pin.`;
}

/** The answer without a reasoning block (the Thinking build opens with one). */
export function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

/** Hebrew letters as a share of all letters; 0 when there are no letters. */
export function hebrewShare(text) {
  const letters = String(text || "").match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  const hebrew = letters.filter((c) => /\p{Script=Hebrew}/u.test(c)).length;
  return hebrew / letters.length;
}

/** Judge one smoke answer: { ok, detail }. */
export function judgeHebrewAnswer(item, raw) {
  const answer = stripThinking(raw);
  if (!answer) return { ok: false, detail: "empty answer" };
  const share = hebrewShare(answer);
  if (share < MIN_HEBREW_SHARE) return { ok: false, detail: `${Math.round(share * 100)}% Hebrew letters (needs ${Math.round(MIN_HEBREW_SHARE * 100)}%)` };
  if (item.anyOf && !item.anyOf.some((w) => answer.includes(w))) return { ok: false, detail: `none of ${item.anyOf.join(" / ")} in the answer` };
  return { ok: true, detail: `${Math.round(share * 100)}% Hebrew letters` };
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");

/** The Markdown report of a Hebrew smoke run. */
export function formatHebrewSmokeReport(results, meta) {
  const ok = results.filter((r) => r.ok).length;
  return [
    `# Hebrew smoke test — ${meta.model}`,
    "",
    `${meta.date} · ${meta.url} · digest ${meta.digest || "unknown"} · temperature 0 · seed 42 · ${(meta.ms / 1000).toFixed(1)} s in all`,
    "",
    `**${ok}/${results.length} prompts** answered in Hebrew${ok === results.length ? "" : " — FAILED"}.`,
    "",
    "| prompt | result | time | detail | answer |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.ok ? "ok" : "FAIL"} | ${(r.ms / 1000).toFixed(1)} s | ${cell(r.detail)} | ${cell(stripThinking(r.answer).slice(0, 160))} |`),
    "",
  ].join("\n");
}
