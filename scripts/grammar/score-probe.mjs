/**
 * Scores a Hebrew grammar checker (plan W5.3) on the probe
 * (eval/probes/hebrew-grammar.json) and on real text:
 *   recall          error sentences where a finding of the expected rule is reported
 *   fpCorrected     corrected sentences with any finding (the same sentences, fixed)
 *   fpRealText      sentences of real Hebrew prose (HeQ dev) with any finding
 *   msPerParagraph  the checker's time per paragraph (p95)
 * Plain JavaScript; `check(text) → [{ offset, length, rule: { id } }]`.
 */
export function scoreGrammar(check, probe, realParagraphs = []) {
  let hit = 0;
  const missed = [];
  for (const it of probe.items) {
    const ms = check(it.text);
    if (ms.some((m) => m.rule.id === `HE_${it.rule}`)) hit++;
    else missed.push(it.id);
  }
  let fpCorr = 0;
  const fpCorrIds = [];
  for (const it of probe.items) {
    if (check(it.corrected).length) {
      fpCorr++;
      fpCorrIds.push(it.id);
    }
  }
  const sentences = realParagraphs.flatMap((p) => p.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10));
  const fpReal = [];
  for (const s of sentences) if (check(s).length) fpReal.push(s);
  const times = realParagraphs.map((p) => {
    const t0 = performance.now();
    check(p);
    return performance.now() - t0;
  });
  times.sort((a, b) => a - b);
  const n = probe.items.length || 1;
  return {
    items: probe.items.length,
    recall: Math.round((hit / n) * 1000) / 1000,
    missed,
    fpCorrected: Math.round((fpCorr / n) * 1000) / 1000,
    fpCorrectedIds: fpCorrIds,
    realSentences: sentences.length,
    fpRealText: sentences.length ? Math.round((fpReal.length / sentences.length) * 1000) / 1000 : null,
    fpRealExamples: fpReal.slice(0, 10),
    msPerParagraphP95: times.length ? Math.round(times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] * 100) / 100 : null,
  };
}
