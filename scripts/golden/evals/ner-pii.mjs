/**
 * Harness for the PII golden set (plan 2.6, 7.1): the redactor in
 * src/ai/pii.ts on patterns alone (the names model, DictaBERT-NER, is not
 * downloadable until 15.9; its numbers come from the browser run).
 *
 *   score({ items }) → {
 *     "recall.patterns"            share of pattern entities (e-mail, phone, ID, card, IBAN, plate, birth date) fully covered
 *     "precision.patterns"         share of redactions that overlap a labelled entity, on the synthetic part
 *     "falseRedactions.negatives"  redactions on the hard negatives (target: ≤ 2 on 100)
 *     "negatives"                  how many hard negatives were scored
 *     "recall.names"               share of PERSON entities covered (patterns only: expected ~0 without NER)
 *   }
 *
 * Run by scripts/golden/run-evals.mjs in CI on the test split; the dev
 * split is scored by src/__tests__/piiGolden.test.ts with the same functions.
 */

export const PATTERN_TYPES = ["EMAIL", "PHONE", "IL_ID", "CREDIT_CARD", "IBAN", "LICENSE_PLATE", "DATE_OF_BIRTH"];

/** The labelled PII of an item in the redactor's types (IAHLT PER → PERSON; places are not scored). */
export function goldOf(item) {
  if (item.part === "iahltwiki" || (!item.kind && item.sentId)) return (item.entities ?? []).filter((e) => e.type === "PER").map((e) => ({ ...e, type: "PERSON" }));
  return item.entities ?? [];
}

/**
 * Score `find(text) → spans` on the items. Pure: the caller supplies the
 * redactor (the dev test imports it directly; CI bundles it with Vite).
 */
export async function scoreWith(find, items) {
  let patGold = 0;
  let patHit = 0;
  let nameGold = 0;
  let nameHit = 0;
  let redactions = 0;
  let correct = 0;
  let negatives = 0;
  let falseOnNegatives = 0;
  for (const it of items) {
    const gold = goldOf(it);
    const found = await find(it.text);
    const covered = (e) => found.some((f) => f.start <= e.start && f.end >= e.end);
    for (const e of gold) {
      if (PATTERN_TYPES.includes(e.type)) {
        patGold++;
        if (covered(e)) patHit++;
      } else if (e.type === "PERSON") {
        nameGold++;
        if (covered(e)) nameHit++;
      }
    }
    // Precision on the synthetic part only: IAHLT labels names, not numbers.
    if (it.kind) {
      for (const f of found) {
        redactions++;
        if (gold.some((e) => f.start < e.end && e.start < f.end)) correct++;
      }
    }
    if (it.kind === "hard-negative") {
      negatives++;
      falseOnNegatives += found.length;
    }
  }
  const r = (x) => Math.round(x * 10000) / 10000;
  return {
    "recall.patterns": patGold ? r(patHit / patGold) : 0,
    "precision.patterns": redactions ? r(correct / redactions) : 1,
    "falseRedactions.negatives": falseOnNegatives,
    negatives,
    "recall.names": nameGold ? r(nameHit / nameGold) : 0,
  };
}

/** The app's redactor (TypeScript) through Vite's bundler, in memory, as retrieval.mjs does for BM25. */
async function loadFind() {
  const { build } = await import("vite");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("../../../src/ai/pii.ts", import.meta.url));
  const out = await build({ configFile: false, logLevel: "silent", build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "pii" } } });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  return (text) => mod.findPii(text);
}

export async function score({ items }) {
  return scoreWith(await loadFind(), items);
}
