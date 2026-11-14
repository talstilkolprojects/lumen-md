/**
 * Diarization error rate and RTTM (plan W2.7), for the golden recordings
 * (scripts/meetings/der.mjs) and the tests. Turns are { start, end, speaker }
 * in seconds.
 */

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/**
 * Diarization error rate: (missed speech + false alarm + speaker confusion)
 * / reference speech time, on a 10 ms grid, with the hypothesis speakers
 * mapped to the reference ones the best way (exhaustive up to 7 speakers,
 * greedy beyond). `collar` seconds around reference boundaries are not
 * scored. Overlapping speech counts per speaker, as in the NIST definition.
 */
export function der(reference, hypothesis, opts = {}) {
  const step = opts.step ?? 0.01;
  const end = Math.max(0, ...reference.map((x) => x.end), ...hypothesis.map((x) => x.end));
  const n = Math.ceil(end / step);
  const refSp = [...new Set(reference.map((x) => x.speaker))];
  const hypSp = [...new Set(hypothesis.map((x) => x.speaker))];
  const at = (turns, names) => {
    const grid = Array.from({ length: n }, () => new Set());
    for (const tr of turns) for (let i = Math.floor(tr.start / step); i < Math.min(n, Math.ceil(tr.end / step)); i++) grid[i].add(names.indexOf(tr.speaker));
    return grid;
  };
  const R = at(reference, refSp);
  const H = at(hypothesis, hypSp);
  const scored = new Array(n).fill(true);
  const collar = opts.collar ?? 0;
  if (collar > 0) for (const tr of reference) for (const b of [tr.start, tr.end]) for (let i = Math.max(0, Math.floor((b - collar) / step)); i < Math.min(n, Math.ceil((b + collar) / step)); i++) scored[i] = false;
  // Overlap matrix for the mapping.
  const overlap = refSp.map(() => hypSp.map(() => 0));
  for (let i = 0; i < n; i++) if (scored[i]) for (const r of R[i]) for (const h of H[i]) overlap[r][h]++;
  let map = []; // hyp index → ref index (or -1)
  if (hypSp.length && refSp.length) {
    if (Math.max(hypSp.length, refSp.length) <= 7) {
      const slots = [...refSp.map((_, i) => i), ...new Array(Math.max(0, hypSp.length - refSp.length)).fill(-1)];
      let best = -1;
      for (const p of permutations(slots)) {
        const m = hypSp.map((_, h) => p[h] ?? -1);
        const s = m.reduce((acc, r, h) => acc + (r >= 0 ? overlap[r][h] : 0), 0);
        if (s > best) [best, map] = [s, m];
      }
    } else {
      map = hypSp.map(() => -1);
      const pairs = refSp.flatMap((_, r) => hypSp.map((_, h) => ({ r, h, o: overlap[r][h] }))).sort((a, b) => b.o - a.o);
      const usedR = new Set();
      for (const p of pairs) {
        if (map[p.h] >= 0 || usedR.has(p.r)) continue;
        map[p.h] = p.r;
        usedR.add(p.r);
      }
    }
  } else map = hypSp.map(() => -1);
  let total = 0;
  let missed = 0;
  let falseAlarm = 0;
  let confusion = 0;
  for (let i = 0; i < n; i++) {
    if (!scored[i]) continue;
    const r = R[i].size;
    const h = H[i].size;
    total += r;
    missed += Math.max(0, r - h);
    falseAlarm += Math.max(0, h - r);
    const mapped = new Set([...H[i]].map((x) => map[x]).filter((x) => x >= 0));
    const correct = [...R[i]].filter((x) => mapped.has(x)).length;
    confusion += Math.min(r, h) - correct;
  }
  const k = step;
  return { der: total ? (missed + falseAlarm + confusion) / total : 0, missed: missed * k, falseAlarm: falseAlarm * k, confusion: confusion * k, total: total * k };
}

/* ─── RTTM ────────────────────────────────────────────────────────── */

export function parseRttm(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "SPEAKER" || f.length < 8) continue;
    const start = Number(f[3]);
    const dur = Number(f[4]);
    if (Number.isFinite(start) && Number.isFinite(dur)) out.push({ start, end: start + dur, speaker: f[7] });
  }
  return out;
}

export function formatRttm(turns, file = "meeting") {
  return turns.map((tr) => `SPEAKER ${file} 1 ${tr.start.toFixed(3)} ${(tr.end - tr.start).toFixed(3)} <NA> <NA> ${tr.speaker.replace(/\s+/g, "_")} <NA> <NA>`).join("\n") + (turns.length ? "\n" : "");
}


/** The `json lumen-speaker-turns` block of a meeting note (src/meetings/meetingTranscribe.ts), or null. */
export function turnsFromNote(md) {
  const m = /```json\s+lumen-speaker-turns\n([\s\S]*?)\n```/.exec(md);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.start === "number" && typeof x.end === "number" && typeof x.speaker === "string") : null;
  } catch {
    return null;
  }
}

/** Pooled DER over recordings: the error times summed over the reference speech summed. */
export function pooledDer(results) {
  const total = results.reduce((s, r) => s + r.total, 0);
  const err = results.reduce((s, r) => s + r.missed + r.falseAlarm + r.confusion, 0);
  return total ? err / total : 0;
}
