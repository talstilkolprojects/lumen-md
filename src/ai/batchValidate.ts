/**
 * Plan 5.8 — the validator a batch job's answers must pass, per operation.
 * Pure (no imports), so the `batch` agent and the tests share it.
 *
 *   tags       a JSON array (or comma list) of 1–10 short tags
 *   summary    one or two plain sentences, not Markdown, not the note itself
 *   translate  not the source text back, and a plausible length
 *
 * A rejected answer goes to the runtime's critic, which may retry once with
 * a hint; a note whose answer still fails is counted as failed with the
 * reason, never written.
 */
export type BatchValidateOp = "tags" | "summary" | "translate";

export type BatchVerdict = { ok: true } | { ok: false; reason: string; hint: string };

const strip = (s: string) => s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

function tagList(answer: string): string[] | null {
  const cleaned = strip(answer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = /[,\n]/.test(cleaned) || /^[\p{L}\p{N}#-]+$/u.test(cleaned) ? cleaned.split(/[,\n]+/) : null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((t) => String(t).trim()).filter(Boolean);
}

/** Sentences in a plain-text answer (rough: ., !, ?, and their CJK / Arabic forms). */
function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?。！？؟])\s+/).filter((s) => s.trim()).length;
}

export function validateBatchAnswer(op: BatchValidateOp, answer: string, source = ""): BatchVerdict {
  const a = answer.trim();
  if (!a) return { ok: false, reason: "empty answer", hint: "Answer with the requested output only." };
  if (op === "tags") {
    const tags = tagList(a);
    if (!tags || !tags.length) return { ok: false, reason: "not a list of tags", hint: 'Output ONLY a JSON array of strings, e.g. ["topic-one","topic-two"].' };
    if (tags.length > 10) return { ok: false, reason: `${tags.length} tags (at most 10)`, hint: "Give 3-7 tags." };
    const long = tags.find((t) => t.length > 40);
    if (long) return { ok: false, reason: "a tag is a sentence, not a tag", hint: "Each tag is one to three words in kebab-case." };
    return { ok: true };
  }
  if (op === "summary") {
    if (/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>)/m.test(a)) return { ok: false, reason: "Markdown in the summary", hint: "Plain sentences only — no headings, lists or quotes." };
    if (sentenceCount(a) > 3 || a.length > 600) return { ok: false, reason: "summary too long", hint: "One or two sentences." };
    const src = source.trim();
    if (src.length > 80 && a.length >= src.length * 0.9) return { ok: false, reason: "the summary is as long as the note", hint: "Summarise; don't repeat the note." };
    return { ok: true };
  }
  const src = source.trim();
  if (src.length > 20 && a === src) return { ok: false, reason: "the translation is the source text", hint: "Translate the text into the target language." };
  if (src.length > 200) {
    const ratio = a.length / src.length;
    if (ratio < 0.2) return { ok: false, reason: "the translation is much shorter than the note", hint: "Translate the whole note, keeping every section." };
    if (ratio > 3) return { ok: false, reason: "the translation is much longer than the note", hint: "Output only the translation." };
  }
  return { ok: true };
}
