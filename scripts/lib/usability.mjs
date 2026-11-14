/**
 * Usability-study analysis (plan W1.29): sessions exported by the in-app
 * recorder (src/research/usability/sessionRecorder.ts) → per-task success,
 * time and ease, SUS per participant and for the round, and the plan's
 * acceptance checks. Pure: scripts/usability-analyze.mjs does the files.
 */

export const SCHEMA = "lumen-usability/1";
export const TASK_COUNT = 10;

/** Plan acceptance (round 2). */
export const TARGETS = { sus: 80, unaidedSuccess: 0.9, severeClosed: 10 };

/** SUS score, 0–100 (same rule as src/research/usability/study.ts). */
export function susScore(answers) {
  if (!Array.isArray(answers) || answers.length !== 10 || answers.some((a) => !Number.isInteger(a) || a < 1 || a > 5)) return null;
  return answers.reduce((sum, a, i) => sum + (i % 2 === 0 ? a - 1 : 5 - a), 0) * 2.5;
}

/** Parse and check one exported session; throws on a file that isn't one. */
export function parseSession(text, name = "session") {
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw new Error(`${name}: not JSON`);
  }
  if (s?.schema !== SCHEMA) throw new Error(`${name}: not a Lumen usability session (schema ${s?.schema})`);
  if (!/^P\d{1,2}$/.test(s.participant ?? "")) throw new Error(`${name}: participant must be a code like P3`);
  if (!Array.isArray(s.events)) throw new Error(`${name}: no events`);
  return s;
}

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Two-sided 95% t critical values by degrees of freedom (1…30); beyond, 1.96. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
export const t95 = (df) => (df < 1 ? null : df <= 30 ? T95[df - 1] : 1.96);

/** Mean with a 95% confidence interval (t distribution: small samples). */
export function meanCI(xs) {
  const m = mean(xs);
  const s = sd(xs);
  if (m === null) return null;
  if (s === null) return { mean: m, low: null, high: null, n: xs.length };
  const h = (t95(xs.length - 1) * s) / Math.sqrt(xs.length);
  return { mean: m, low: m - h, high: m + h, n: xs.length };
}

/** Each task attempt in a session: start → end, outcome, assisted, seconds. Unfinished starts count as gave-up. */
export function attempts(session) {
  const out = [];
  let open = null;
  for (const e of session.events) {
    if (e.type === "task-start") {
      if (open) out.push({ ...open, outcome: "gave-up", assisted: false, seconds: (e.t - open.t0) / 1000, unfinished: true });
      open = { task: e.task, t0: e.t, errors: 0, help: 0, notes: [] };
    } else if (open && e.type === "task-end" && e.task === open.task) {
      out.push({ ...open, outcome: e.outcome, assisted: !!e.assisted, seconds: (e.t - open.t0) / 1000 });
      open = null;
    } else if (open && e.type === "error") open.errors++;
    else if (open && e.type === "command" && /^help\./.test(e.id)) open.help++;
    else if (open && e.type === "note") open.notes.push(e.code);
  }
  if (open) out.push({ ...open, outcome: "gave-up", assisted: false, seconds: null, unfinished: true });
  return out.map(({ t0, ...a }) => ({ ...a, participant: session.participant }));
}

/** The round's numbers. `sessions` are parsed sessions (one round). */
export function analyze(sessions) {
  const all = sessions.flatMap(attempts);
  const tasks = [];
  for (let id = 1; id <= TASK_COUNT; id++) {
    const a = all.filter((x) => x.task === id);
    const n = a.length;
    const ok = a.filter((x) => x.outcome === "success");
    const unaided = ok.filter((x) => !x.assisted);
    const partial = a.filter((x) => x.outcome === "partial");
    const times = ok.map((x) => x.seconds).filter((x) => typeof x === "number");
    const seq = sessions.map((s) => s.seq?.[id] ?? s.seq?.[String(id)]).filter((v) => Number.isInteger(v));
    tasks.push({
      task: id,
      n,
      success: n ? ok.length / n : null,
      unaidedSuccess: n ? unaided.length / n : null,
      lenient: n ? (ok.length + 0.5 * partial.length) / n : null,
      medianSeconds: median(times),
      seq: mean(seq),
      errors: a.reduce((k, x) => k + x.errors, 0),
      help: a.reduce((k, x) => k + x.help, 0),
      notes: a.flatMap((x) => x.notes),
    });
  }
  const sus = sessions.map((s) => ({ participant: s.participant, score: susScore(s.sus) }));
  const scores = sus.map((x) => x.score).filter((x) => x !== null);
  const attempted = all.length;
  const unaidedAll = all.filter((x) => x.outcome === "success" && !x.assisted).length;
  return {
    participants: sessions.map((s) => s.participant),
    rounds: [...new Set(sessions.map((s) => s.round))],
    tasks,
    sus,
    susCI: meanCI(scores),
    unaidedSuccess: attempted ? unaidedAll / attempted : null,
  };
}

/**
 * Severe issues from the findings file (research/usability/findings-template.he.md):
 * the issues table's rows, `| ID | … | severity | … | status |`. Severity 3–4 is
 * severe (Nielsen's scale); status "סגור" / "closed" counts as closed.
 */
export function parseFindings(md) {
  const rows = [];
  let header = null;
  for (const line of String(md).split("\n")) {
    if (!/^\s*\|/.test(line)) {
      header = null;
      continue;
    }
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (!header) {
      if (cells.some((c) => /^(מזהה|ID)$/i.test(c))) header = cells;
      continue;
    }
    const col = (re) => cells[header.findIndex((h) => re.test(h))] ?? "";
    const id = col(/^(מזהה|ID)$/i);
    if (!/^U\d+/.test(id)) continue;
    const severity = Number(/\d/.exec(col(/חומרה|severity/i))?.[0] ?? NaN);
    const status = col(/סטטוס|status/i);
    rows.push({ id, severity, closed: /^(סגור|closed|fixed|תוקן)/i.test(status) });
  }
  return rows;
}

/** The plan's acceptance for a round-2 analysis. */
export function acceptance(result, findings = []) {
  const severe = findings.filter((f) => f.severity >= 3).slice(0, TARGETS.severeClosed);
  const closed = severe.filter((f) => f.closed).length;
  return [
    { name: "SUS ≥ 80", ok: result.susCI ? result.susCI.mean >= TARGETS.sus : false, value: result.susCI ? result.susCI.mean.toFixed(1) : "—" },
    { name: "≥ 90% unaided success", ok: result.unaidedSuccess !== null && result.unaidedSuccess >= TARGETS.unaidedSuccess, value: result.unaidedSuccess === null ? "—" : `${Math.round(result.unaidedSuccess * 100)}%` },
    { name: "10/10 severe issues closed", ok: severe.length >= TARGETS.severeClosed && closed === severe.length, value: `${closed}/${severe.length}` },
  ];
}

const pct = (x) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const num = (x, d = 1) => (x === null || x === undefined ? "—" : x.toFixed(d));

/** The report, in Hebrew with the numbers (Markdown). */
export function report(result, { round, taskNames = [], findings = null } = {}) {
  const L = [];
  L.push(`# דוח בדיקות שימושיות — סבב ${round ?? result.rounds.join(", ")}`, "");
  L.push(`משתתפים: ${result.participants.length} (${result.participants.join(", ")})`, "");
  L.push("## משימות", "", "| # | משימה | ניסיונות | הצלחה | הצלחה בלי עזרה | כולל חלקית | זמן חציוני (שנ׳) | SEQ (1–7) | שגיאות | עזרה |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const t of result.tasks) L.push(`| ${t.task} | ${taskNames[t.task - 1] ?? ""} | ${t.n} | ${pct(t.success)} | ${pct(t.unaidedSuccess)} | ${pct(t.lenient)} | ${num(t.medianSeconds, 0)} | ${num(t.seq)} | ${t.errors} | ${t.help} |`);
  L.push("", "## SUS", "", "| משתתף/ת | ציון |", "|---|---|");
  for (const s of result.sus) L.push(`| ${s.participant} | ${s.score === null ? "—" : s.score.toFixed(1)} |`);
  const ci = result.susCI;
  L.push("", ci ? `ממוצע: **${ci.mean.toFixed(1)}**${ci.low !== null ? ` (רווח סמך 95%: ${Math.max(0, ci.low).toFixed(1)}–${Math.min(100, ci.high).toFixed(1)}, n=${ci.n})` : ` (n=${ci.n})`}` : "אין תשובות SUS.", "");
  L.push(`הצלחה בלי עזרה, בכל המשימות: **${pct(result.unaidedSuccess)}**`, "");
  if (round === 2 || findings) {
    L.push("## קריטריוני קבלה (סבב 2)", "", "| קריטריון | ערך | עומד? |", "|---|---|---|");
    for (const a of acceptance(result, findings ?? [])) L.push(`| ${a.name} | ${a.value} | ${a.ok ? "✓" : "✗"} |`);
    L.push("");
  }
  L.push("> עם 5–8 משתתפים המספרים מראים כיוון, לא מובהקות. רווחי הסמך רחבים, וכל בעיה שחזרה אצל שניים או יותר שווה בדיקה.", "");
  return L.join("\n");
}
