/**
 * Read-aloud listening test (plan W2.6): MOS from raters' 1–5 scores on the
 * 20 golden sentences (eval/listening/tts-he.json). Pure; used by
 * scripts/tts-mos.mjs and pinned by src/__tests__/ttsMos.test.ts.
 *
 * Acceptance: mean opinion score ≥ 3.8 over ≥ 5 raters who each scored
 * every sentence.
 */

export const TARGET = 3.8;
export const MIN_RATERS = 5;

/** A blank CSV sheet: one row per rater × sentence, the score left empty. */
export function sheet(sentenceIds, raters) {
  const rows = ["rater,sentence,score"];
  for (const r of raters) for (const id of sentenceIds) rows.push(`${r},${id},`);
  return rows.join("\n") + "\n";
}

/** "rater,sentence,score" CSV → rows; a header line is skipped. */
export function parseRatings(csv) {
  const rows = [];
  for (const [n, line] of String(csv).split(/\r?\n/).entries()) {
    const l = line.trim();
    if (!l || (n === 0 && /^rater\s*,/i.test(l))) continue;
    const [rater, sentence, score] = l.split(",").map((x) => x.trim());
    rows.push({ line: n + 1, rater, sentence, score: score === "" || score === undefined ? null : Number(score) });
  }
  return rows;
}

/** Problems that make the ratings unusable (empty = ok). */
export function validateRatings(rows, sentenceIds) {
  const problems = [];
  const ids = new Set(sentenceIds);
  const seen = new Set();
  for (const r of rows) {
    if (!r.rater) problems.push(`line ${r.line}: no rater`);
    if (!ids.has(r.sentence)) problems.push(`line ${r.line}: unknown sentence "${r.sentence}"`);
    if (r.score === null || !Number.isInteger(r.score) || r.score < 1 || r.score > 5) problems.push(`line ${r.line}: score must be a whole number 1–5`);
    const key = `${r.rater}|${r.sentence}`;
    if (seen.has(key)) problems.push(`line ${r.line}: ${r.rater} scored ${r.sentence} twice`);
    seen.add(key);
  }
  const raters = [...new Set(rows.map((r) => r.rater).filter(Boolean))];
  if (raters.length < MIN_RATERS) problems.push(`${raters.length} raters; the test needs at least ${MIN_RATERS}`);
  for (const rater of raters) {
    const missing = sentenceIds.filter((id) => !seen.has(`${rater}|${id}`));
    if (missing.length) problems.push(`${rater} did not score ${missing.length} sentence(s): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`);
  }
  return problems;
}

const round2 = (x) => Math.round(x * 100) / 100;

/** MOS, its 95% confidence interval, per sentence and per rater, and the verdict. */
export function mos(rows) {
  const scores = rows.map((r) => r.score);
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
  const by = (k) => {
    const m = new Map();
    for (const r of rows) m.set(r[k], [...(m.get(r[k]) ?? []), r.score]);
    return Object.fromEntries([...m].map(([key, v]) => [key, round2(v.reduce((a, b) => a + b, 0) / v.length)]));
  };
  return { mos: round2(mean), ci95: [round2(mean - half), round2(mean + half)], n, raters: new Set(rows.map((r) => r.rater)).size, perSentence: by("sentence"), perRater: by("rater"), target: TARGET, pass: mean >= TARGET };
}
