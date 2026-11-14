/**
 * Scores a literature-review run (plan W5.12) against gold papers:
 *   fieldAccuracy    fields whose value is kept and one of whose citations
 *                    is on the gold page and quotes (part of) the gold phrase
 *   citationPages    citations kept on the page their passage came from
 *                    (always 1 when verification works: the test asserts it)
 *   uncited          values kept without a citation (must be 0)
 * Plain JavaScript, shared by the unit test and the real-model eval.
 */
const squash = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** Do two texts share a run of at least `n` words? */
function overlaps(a, b, n = 4) {
  const wa = squash(a).split(" ");
  const sb = ` ${squash(b)} `;
  for (let i = 0; i + n <= wa.length; i++) if (sb.includes(` ${wa.slice(i, i + n).join(" ")} `)) return true;
  return wa.length < n && sb.includes(` ${squash(a)} `);
}

export function scoreLitReview(results, gold) {
  let fields = 0;
  let correct = 0;
  let uncited = 0;
  const wrong = [];
  for (const g of gold) {
    const r = results.find((x) => x.id === g.id);
    for (const [key, want] of Object.entries(g.gold)) {
      fields++;
      const f = r?.fields.find((x) => x.key === key);
      if (f?.value && !f.citations.length) uncited++;
      const ok = !!f?.value && f.citations.some((c) => c.page === want.page && (overlaps(c.quote, want.phrase) || overlaps(want.phrase, c.quote)));
      if (ok) correct++;
      else wrong.push(`${g.id}.${key}`);
    }
  }
  return { papers: gold.length, fields, fieldAccuracy: fields ? Math.round((correct / fields) * 1000) / 1000 : 0, uncited, wrong };
}
