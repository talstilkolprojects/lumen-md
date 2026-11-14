/**
 * The beta funnel (plan W6.31), from the opt-in reports only.
 *
 * Input: the weekly reports testers chose to send (src/beta/programme.ts,
 * `kind: "lumen-beta-report"`), each with the tester it came from. On
 * GitHub that is the account that submitted the `beta-report` issue — the
 * reports themselves carry no id. Anything that is not a valid beta report
 * is skipped and counted; only the known fields of a report are read.
 *
 * Definitions (launch/launch-plan.md): a tester is *active* in a week when
 * the report shows Lumen opened on 3 or more of its 7 days; *all week* on
 * all 7. The plan's acceptance ("50 beta testers active for 7 days") is read
 * as: some week has ≥ 50 active testers.
 *
 * Beta targets (plan W11.P4, research R6 §5, gates M1/M2): activation ≥ 50%,
 * D7 ≥ 30%, D30 ≥ 15%. Each rate is over the testers whose reports can say
 * (activation decided, a 7- or 30-day window old enough); a tester counts
 * as yes when any of their reports says yes. TTFV figures are the averages
 * the devices computed (W11.P4); the funnel only averages them again.
 */

/** The beta's targets, here in code so a report can't move them (W11.P4). Never lower these. */
export const BETA_TARGETS = Object.freeze({ activation: 0.5, d7: 0.3, d30: 0.15 });

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const count = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);

/** The report in a text: a ```json block (an issue body) or the whole text. Null when it is not a beta report. */
export function parseReport(text) {
  const s = String(text ?? "");
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(s);
  let raw;
  try {
    raw = JSON.parse(m ? m[1] : s);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.kind !== "lumen-beta-report" || raw.v !== 1) return null;
  if (!DAY.test(String(raw.week)) || !DAY.test(String(raw.cohort))) return null;
  const daysActive7 = count(raw.daysActive7);
  if (daysActive7 === null || daysActive7 > 7) return null;
  return {
    week: raw.week,
    cohort: raw.cohort,
    app: typeof raw.app === "string" ? raw.app.slice(0, 40) : "",
    channel: raw.channel === "beta" ? "beta" : "stable",
    weeksInBeta: count(raw.weeksInBeta) ?? 0,
    daysActive7,
    daysActive30: count(raw.daysActive30) ?? 0,
    opens7: count(raw.opens7) ?? 0,
    errors7: count(raw.errors7) ?? 0,
    retained7: raw.retained7 === true ? true : raw.retained7 === false ? false : null,
    retained30: raw.retained30 === true ? true : raw.retained30 === false ? false : null,
    activation: parseActivation(raw.activation),
    topFeatures: Object.fromEntries(
      Object.entries(raw.topFeatures && typeof raw.topFeatures === "object" ? raw.topFeatures : {})
        .filter(([k, v]) => /^[a-z][a-zA-Z0-9_.:-]{0,80}$/.test(k) && count(v) !== null)
        .map(([k, v]) => [k, count(v)]),
    ),
  };
}

const yesNo = (v) => (v === true ? true : v === false ? false : null);
const millis = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 86_400_000 ? Math.round(v) : null);

/** The activation block of a report (W11.P4): its known fields only, or null. */
function parseActivation(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  return { activated: yesNo(a.activated), ownNote: a.ownNote === true, imported: a.imported === true, returnedDay2: a.returnedDay2 === true, ttfv1MeanMs: millis(a.ttfv1MeanMs), ttfv2Ms: millis(a.ttfv2Ms) };
}

/** A rate over the testers that can say: yes / (yes + no), and whether it meets `target`. */
function rate(testers, pick, target) {
  let yes = 0;
  let known = 0;
  for (const t of testers) {
    const vals = t.weeks.map(pick).filter((v) => v !== null);
    if (!vals.length) continue;
    known++;
    if (vals.includes(true)) yes++;
  }
  const value = known ? yes / known : null;
  return { yes, of: known, rate: value, target, met: value !== null && value >= target };
}

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * The funnel over `{ tester, text }` records. One report per tester and
 * week counts (the last one given wins, as a resend replaces a report).
 */
export function funnel(records, { target = 50 } = {}) {
  const byKey = new Map();
  let skipped = 0;
  for (const r of records) {
    const tester = String(r.tester ?? "").trim();
    const rep = parseReport(r.text);
    if (!tester || !rep) {
      skipped++;
      continue;
    }
    byKey.set(`${tester}\u0000${rep.week}`, { tester, ...rep });
  }
  const reports = [...byKey.values()];
  const testers = new Map();
  for (const r of reports) {
    const t = testers.get(r.tester) ?? { cohort: r.cohort, weeks: [] };
    if (r.cohort < t.cohort) t.cohort = r.cohort;
    t.weeks.push(r);
    testers.set(r.tester, t);
  }
  const all = [...testers.values()];
  const stage = (pred) => all.filter((t) => t.weeks.some(pred)).length;
  const weeks = [...new Set(reports.map((r) => r.week))].sort().map((week) => {
    const rs = reports.filter((r) => r.week === week);
    return { week, reported: rs.length, active: rs.filter((r) => r.daysActive7 >= 3).length, allWeek: rs.filter((r) => r.daysActive7 === 7).length, beta: rs.filter((r) => r.channel === "beta").length };
  });
  const cohorts = [...new Set(all.map((t) => t.cohort))].sort().map((cohort) => {
    const ts = all.filter((t) => t.cohort === cohort);
    const s = (pred) => ts.filter((t) => t.weeks.some(pred)).length;
    return { cohort, testers: ts.length, active: s((r) => r.daysActive7 >= 3), retained: s((r) => r.retained7 === true), secondWeek: s((r) => r.weeksInBeta >= 1) };
  });
  const features = new Map();
  for (const r of reports) for (const [k, v] of Object.entries(r.topFeatures)) features.set(k, (features.get(k) ?? 0) + v);
  const bestWeek = weeks.reduce((b, w) => (!b || w.active > b.active ? w : b), null);
  // Per tester, their latest report's device averages (a later week supersedes an earlier one).
  const latest = all.map((t) => [...t.weeks].sort((a, b) => (a.week < b.week ? -1 : 1)).at(-1));
  const ttfv1 = latest.map((r) => r.activation?.ttfv1MeanMs ?? null).filter((v) => v !== null);
  const ttfv2 = latest.map((r) => r.activation?.ttfv2Ms ?? null).filter((v) => v !== null);
  return {
    reports: reports.length,
    skipped,
    stages: {
      reported: all.length,
      active: stage((r) => r.daysActive7 >= 3),
      allWeek: stage((r) => r.daysActive7 === 7),
      retained: stage((r) => r.retained7 === true),
      secondWeek: stage((r) => r.weeksInBeta >= 1),
    },
    weeks,
    cohorts,
    topFeatures: [...features.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15),
    errorsPerReport: reports.length ? Math.round((reports.reduce((s, r) => s + r.errors7, 0) / reports.length) * 100) / 100 : 0,
    target: { active: target, bestWeek: bestWeek?.week ?? null, bestActive: bestWeek?.active ?? 0, met: (bestWeek?.active ?? 0) >= target },
    beta: {
      activation: rate(all, (r) => r.activation?.activated ?? null, BETA_TARGETS.activation),
      d7: rate(all, (r) => r.retained7, BETA_TARGETS.d7),
      d30: rate(all, (r) => r.retained30, BETA_TARGETS.d30),
      ttfv1MeanMs: mean(ttfv1),
      ttfv1Testers: ttfv1.length,
      ttfv2MedianMs: median(ttfv2),
      ttfv2Testers: ttfv2.length,
    },
  };
}

/** The funnel as Markdown, Hebrew headings with the English in brackets (the owner reads it; the issues are English). */
export function funnelMarkdown(f) {
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  const s = f.stages;
  const lines = [
    "# משפך הבטא (Beta funnel)",
    "",
    `דוחות תקינים: ${f.reports} · דוחות שנדחו: ${f.skipped}`,
    "",
    "| שלב (stage) | בודקים | מתוך המדווחים |",
    "|---|---|---|",
    `| דיווחו (reported) | ${s.reported} | 100% |`,
    `| פעילים ≥ 3 ימים בשבוע (active) | ${s.active} | ${pct(s.active, s.reported)} |`,
    `| כל 7 הימים (all week) | ${s.allWeek} | ${pct(s.allWeek, s.reported)} |`,
    `| חזרו אחרי שבוע (retained7) | ${s.retained} | ${pct(s.retained, s.reported)} |`,
    `| דיווחו בשבוע השני ואילך (second week) | ${s.secondWeek} | ${pct(s.secondWeek, s.reported)} |`,
    "",
    "## לפי שבוע (by week)",
    "",
    "| שבוע | דיווחו | פעילים | כל השבוע | בערוץ בטא |",
    "|---|---|---|---|---|",
    ...f.weeks.map((w) => `| ${w.week} | ${w.reported} | ${w.active} | ${w.allWeek} | ${w.beta} |`),
    "",
    "## לפי קבוצת הצטרפות (by cohort)",
    "",
    "| שבוע הצטרפות | בודקים | פעילים | חזרו | שבוע שני |",
    "|---|---|---|---|---|",
    ...f.cohorts.map((c) => `| ${c.cohort} | ${c.testers} | ${c.active} | ${c.retained} | ${c.secondWeek} |`),
    "",
    `## היעד (target): ${f.target.active} בודקים פעילים בשבוע`,
    "",
    f.target.bestWeek ? `השבוע הטוב ביותר: ${f.target.bestWeek}, ${f.target.bestActive} פעילים — ${f.target.met ? "✅ הושג" : "⏳ עוד לא"}` : "אין עדיין דוחות.",
    "",
    "## הפקודות הנפוצות (top commands)",
    "",
    ...(f.topFeatures.length ? f.topFeatures.map(([k, v]) => `- \`${k}\` × ${v}`) : ["—"]),
    "",
    `שגיאות לדוח, בממוצע: ${f.errorsPerReport}`,
    "",
    "## יעדי הבטא (beta targets, W11.P4)",
    "",
    "| מדד | בפועל | יעד | |",
    "|---|---|---|---|",
    ...[
      ["הפעלה (activation)", f.beta.activation],
      ["D7", f.beta.d7],
      ["D30", f.beta.d30],
    ].map(([name, r]) => `| ${name} | ${r.rate === null ? "—" : `${pct(r.yes, r.of)} (${r.yes}/${r.of})`} | ≥ ${Math.round(r.target * 100)}% | ${r.rate === null ? "⏳ אין נתונים" : r.met ? "✅" : "❌"} |`),
    "",
    `TTFV-1 (פתיחה→סמן), ממוצע המכשירים: ${f.beta.ttfv1MeanMs === null ? "—" : `${f.beta.ttfv1MeanMs} ms (${f.beta.ttfv1Testers})`}`,
    `TTFV-2 (פתק ראשון משלך), חציון: ${f.beta.ttfv2MedianMs === null ? "—" : `${Math.round(f.beta.ttfv2MedianMs / 1000)} s (${f.beta.ttfv2Testers})`}`,
    "",
  ];
  return lines.join("\n");
}
