#!/usr/bin/env node
/**
 * The accessibility conformance report (plan W3.8): docs/acr/wcag22.json is
 * the source — one entry per WCAG 2.2 level A and AA success criterion,
 * with a status, remarks in English and Hebrew, evidence and, for anything
 * short of "supports", a remediation plan with a target release. This
 * script checks it and writes the two docs pages from it:
 *
 *   docs/src/content/docs/editor/acr.md      (English)
 *   docs/src/content/docs/he/editor/acr.md   (Hebrew)
 *
 *   node scripts/acr.mjs            # check, then write the pages
 *   node scripts/acr.mjs --check    # check, and fail if the pages are stale (CI, release)
 *
 * Rules: every A / AA criterion has a status; none at level A is "does not
 * support"; every partial or unsupported one has a plan; every evidence
 * path exists; the report's version is the app's version.
 *
 * The automated part comes from axe (docs/acr/axe.json, written by
 * scripts/acr-axe.mjs from an axe-core run): each criterion shows the axe
 * rules that test it and how they came out, and a criterion axe finds a
 * violation of can't be "supports" (or "not applicable").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = "docs/acr/wcag22.json";
export const AXE = "docs/acr/axe.json";
export const PAGES = { en: "docs/src/content/docs/editor/acr.md", he: "docs/src/content/docs/he/editor/acr.md" };

/** WCAG 2.2 level A and AA success criteria (4.1.1 Parsing was removed in 2.2). */
export const WCAG22 = {
  A: ["1.1.1", "1.2.1", "1.2.2", "1.2.3", "1.3.1", "1.3.2", "1.3.3", "1.4.1", "1.4.2", "2.1.1", "2.1.2", "2.1.4", "2.2.1", "2.2.2", "2.3.1", "2.4.1", "2.4.2", "2.4.3", "2.4.4", "2.5.1", "2.5.2", "2.5.3", "2.5.4", "3.1.1", "3.2.1", "3.2.2", "3.2.6", "3.3.1", "3.3.2", "3.3.7", "4.1.2"],
  AA: ["1.2.4", "1.2.5", "1.3.4", "1.3.5", "1.4.3", "1.4.4", "1.4.5", "1.4.10", "1.4.11", "1.4.12", "1.4.13", "2.4.5", "2.4.6", "2.4.7", "2.4.11", "2.5.7", "2.5.8", "3.1.2", "3.2.3", "3.2.4", "3.3.3", "3.3.4", "3.3.8", "4.1.3"],
};
export const STATUSES = ["supports", "partially-supports", "does-not-support", "not-applicable"];
const LABEL = {
  en: { supports: "Supports", "partially-supports": "Partially supports", "does-not-support": "Does not support", "not-applicable": "Not applicable" },
  he: { supports: "נתמך", "partially-supports": "נתמך חלקית", "does-not-support": "לא נתמך", "not-applicable": "לא רלוונטי" },
};

export function loadReport(root = ROOT) {
  return JSON.parse(readFileSync(join(root, SOURCE), "utf8"));
}

/** The axe run (scripts/acr-axe.mjs), or null when there is none. */
export function loadAxe(root = ROOT) {
  const f = join(root, AXE);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

/** What axe checked for criterion `id`: its rules, their passes, violations and results to review by hand. */
export function automatedFor(id, axe) {
  const out = { rules: [], pass: 0, fail: 0, incomplete: 0, failures: [] };
  for (const [rule, r] of Object.entries(axe?.rules ?? {})) {
    if (!r.criteria.includes(id)) continue;
    out.rules.push(rule);
    out.pass += r.pass;
    out.fail += r.fail;
    out.incomplete += r.incomplete;
    out.failures.push(...r.failures.map((f) => ({ rule, ...f })));
  }
  return out;
}

/** Problems with the report (empty = good). */
export function checkReport(report, root = ROOT, axe = loadAxe(root)) {
  const problems = [];
  if (!axe) problems.push(`${AXE} is missing: run axe and node scripts/acr-axe.mjs (plan W3.8)`);
  const byId = new Map(report.criteria.map((c) => [c.id, c]));
  if (byId.size !== report.criteria.length) problems.push("a criterion is listed twice");
  for (const [level, ids] of Object.entries(WCAG22)) {
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) {
        problems.push(`${id} (${level}) has no entry`);
        continue;
      }
      if (c.level !== level) problems.push(`${id} is level ${level}, not ${c.level}`);
      if (!STATUSES.includes(c.status)) problems.push(`${id}: status "${c.status}" is not one of ${STATUSES.join(", ")}`);
      if (level === "A" && c.status === "does-not-support") problems.push(`${id}: a level A criterion is "does not support"`);
      if (!c.remarks?.en?.trim() || !c.remarks?.he?.trim()) problems.push(`${id}: remarks in English and Hebrew are required`);
      else if (!/[֐-׿]/.test(c.remarks.he)) problems.push(`${id}: the Hebrew remarks are not in Hebrew`);
      if ((c.status === "partially-supports" || c.status === "does-not-support") && !(c.plan?.en && c.plan?.he && c.plan?.target)) problems.push(`${id}: ${c.status} needs a plan (en, he, target)`);
      for (const e of c.evidence ?? []) if (!existsSync(join(root, e))) problems.push(`${id}: evidence ${e} does not exist`);
      const auto = automatedFor(id, axe);
      if (auto.fail && (c.status === "supports" || c.status === "not-applicable")) problems.push(`${id}: axe finds ${auto.fail} violation(s) (${[...new Set(auto.failures.map((f) => f.rule))].join(", ")}), so it can't be "${c.status}"`);
    }
  }
  for (const c of report.criteria) if (!WCAG22.A.includes(c.id) && !WCAG22.AA.includes(c.id)) problems.push(`${c.id} is not a WCAG 2.2 A / AA criterion`);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (report.version !== pkg.version) problems.push(`the report is for ${report.version}, the app is ${pkg.version}: review it for this release`);
  return problems;
}

export function summary(report) {
  const out = {};
  for (const level of ["A", "AA"]) {
    out[level] = Object.fromEntries(STATUSES.map((s) => [s, report.criteria.filter((c) => c.level === level && c.status === s).length]));
  }
  return out;
}

const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The docs page in one language. */
const n = (x, lang) => x.toLocaleString(lang === "he" ? "he-IL" : "en-US");

/** The automated column for one criterion. */
export function automatedCell(id, axe, lang) {
  const he = lang === "he";
  const a = automatedFor(id, axe);
  if (!a.rules.length) return he ? "— (axe לא בודק את זה)" : "— (not testable by axe)";
  if (a.fail) {
    const by = [...new Set(a.failures.map((f) => `${f.rule} (${f.surface}, ${f.setup})`))].slice(0, 4).join("; ");
    return he ? `✗ ${n(a.fail, lang)} הפרות: ${by}` : `✗ ${n(a.fail, lang)} violation${a.fail === 1 ? "" : "s"}: ${by}`;
  }
  const review = a.incomplete ? (he ? `, ${n(a.incomplete, lang)} לבדיקה ידנית` : `, ${n(a.incomplete, lang)} to review by hand`) : "";
  return he ? `✓ ${a.rules.length} כללים, ${n(a.pass, lang)} בדיקות עברו${review}` : `✓ ${a.rules.length} rule${a.rules.length === 1 ? "" : "s"}, ${n(a.pass, lang)} checks passed${review}`;
}

/** The "Automated testing" section: which axe run, on what, and what it can't tell. */
function axeSection(axe, lang) {
  const he = lang === "he";
  if (!axe) return [];
  const rules = Object.keys(axe.rules).length;
  const failing = Object.values(axe.rules).filter((r) => r.fail).length;
  return [
    he ? "## בדיקה אוטומטית" : "## Automated testing",
    "",
    he
      ? `**${axe.tool} ${axe.version}**, ${axe.source}, ב-${axe.date} (commit \`${axe.commit}\`): ${n(axe.runs, lang)} הרצות על ${axe.surfaces.length} משטחים × ${axe.setups.length} הגדרות (${axe.setups.join(", ")}), ${rules} כללים של WCAG 2.0/2.1/2.2 ברמות A ו-AA, ${failing ? `**${failing} כללים עם הפרות**` : "**אפס הפרות**"}. העמודה ״axe״ בטבלאות למטה מראה, לכל קריטריון, את הכללים שבודקים אותו ואת התוצאה. axe בודק רק חלק מ-WCAG; כל השאר נבדק ידנית, כמתואר למעלה.`
      : `**${axe.tool} ${axe.version}**, ${axe.source}, on ${axe.date} (commit \`${axe.commit}\`): ${n(axe.runs, lang)} runs on ${axe.surfaces.length} surfaces × ${axe.setups.length} setups (${axe.setups.join(", ")}), ${rules} WCAG 2.0/2.1/2.2 A and AA rules, ${failing ? `**${failing} rules with violations**` : "**zero violations**"}. The "axe" column below shows, for each criterion, the rules that test it and how they came out. axe tests only part of WCAG; the rest is checked by hand, as described above.`,
    ...(axe.notRun?.length ? ["", (he ? "לא נבדקו באופן הזה (נבדקים ב-e2e): " : "Not tested this way (covered by the e2e suite): ") + axe.notRun.map((x) => x.split(":")[0]).join(", ") + "."] : []),
    "",
  ];
}

export function renderPage(report, lang, axe = loadAxe()) {
  const L = LABEL[lang];
  const he = lang === "he";
  const s = summary(report);
  const order = [...WCAG22.A, ...WCAG22.AA];
  const rows = [...report.criteria].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const lines = [
    "---",
    `title: ${he ? "דוח תאימות נגישות (ACR) — WCAG 2.2" : "Accessibility conformance report (ACR) — WCAG 2.2"}`,
    `description: ${he ? `כל קריטריון הצלחה של WCAG 2.2 ברמות A ו-AA, עם הסטטוס של Lumen ${report.version}, הערות, ראיות ותוכנית תיקון.` : `Every WCAG 2.2 level A and AA success criterion, with Lumen ${report.version}'s status, remarks, evidence and remediation plan.`}`,
    "---",
    "",
    he ? "<!-- נוצר על ידי scripts/acr.mjs מתוך docs/acr/wcag22.json — לערוך שם. -->" : "<!-- Generated by scripts/acr.mjs from docs/acr/wcag22.json — edit that file. -->",
    "",
    he
      ? `הדוח הזה בנוי לפי מבנה ה-VPAT®‏ 2.5 (מהדורת WCAG). הוא מכסה את **${report.product} ${report.version}** (אתר, שולחן עבודה ונייד) מול **${report.standard}** ברמות A ו-AA, ונבדק לאחרונה ב-**${report.reviewed}**. הוא מתפרסם מחדש עם כל שחרור משמעותי: הבדיקה \`node scripts/acr.mjs --check\` נכשלת כשגרסת הדוח שונה מגרסת האפליקציה.`
      : `This report follows the structure of the VPAT® 2.5 (WCAG edition). It covers **${report.product} ${report.version}** (web, desktop and mobile) against **${report.standard}** levels A and AA, and was last reviewed on **${report.reviewed}**. It is published again with every major release: \`node scripts/acr.mjs --check\` fails when the report's version and the app's differ.`,
    "",
    he ? "## סיכום" : "## Summary",
    "",
    he ? "| רמה | נתמך | נתמך חלקית | לא נתמך | לא רלוונטי |" : "| Level | Supports | Partially supports | Does not support | Not applicable |",
    "|---|---|---|---|---|",
    ...["A", "AA"].map((lv) => `| ${lv} | ${s[lv].supports} | ${s[lv]["partially-supports"]} | ${s[lv]["does-not-support"]} | ${s[lv]["not-applicable"]} |`),
    "",
    he ? "## איך נבדק" : "## How it was evaluated",
    "",
    report.method[lang],
    "",
    ...axeSection(axe, lang),
  ];
  for (const level of ["A", "AA"]) {
    lines.push(he ? `## רמה ${level}` : `## Level ${level}`, "", he ? "| קריטריון | סטטוס | הערות | axe |" : "| Criterion | Status | Remarks | axe |", "|---|---|---|---|");
    for (const c of rows.filter((x) => x.level === level)) {
      const link = `[${c.id} ${c.name}](https://www.w3.org/WAI/WCAG22/Understanding/${slug(c.name)})`;
      const plan = c.plan ? ` ${he ? "**תוכנית:**" : "**Plan:**"} ${c.plan[lang]} (${c.plan.target})` : "";
      lines.push(`| ${link} | ${L[c.status]} | ${esc(c.remarks[lang])}${esc(plan)} | ${esc(automatedCell(c.id, axe, lang))} |`);
    }
    lines.push("");
  }
  const todo = rows.filter((c) => c.plan);
  lines.push(he ? "## חריגים ותוכנית תיקון" : "## Exceptions and remediation plan", "");
  lines.push(he ? "כל קריטריון שאינו נתמך במלואו, ומה ייעשה לגביו:" : "Every criterion not fully supported, and what will be done about it:", "");
  for (const c of todo) lines.push(`- **${c.id} ${c.name}** (${c.level}, ${L[c.status]}): ${c.plan[lang]} ${he ? "יעד" : "Target"}: ${c.plan.target}.`);
  lines.push("");
  lines.push(he ? "## הוסר ב-WCAG 2.2" : "## Removed in WCAG 2.2", "");
  for (const r of report.removed) lines.push(`- ${r.id} ${r.name}: ${r.note[lang]}`);
  lines.push("");
  lines.push(he ? "## פנייה בנושא נגישות" : "## Accessibility contact", "");
  lines.push(
    he
      ? "נתקלתם בחסם? פתחו [דיווח נגישות](https://github.com/talstilkol/lumen-md/issues/new?template=accessibility.yml) (טופס עם התווית **accessibility**), או בחרו **דיווח על בעיית נגישות** בפלטת הפקודות. דיווחי נגישות מטופלים לפני באגים אחרים. ראו גם את [הצהרת הנגישות](/he/editor/accessibility-statement/)."
      : "Hit a barrier? Open an [accessibility report](https://github.com/talstilkol/lumen-md/issues/new?template=accessibility.yml) (a form labelled **accessibility**), or choose **Report an accessibility problem** in the command palette. Accessibility reports are triaged before other bugs. See also the [accessibility statement](/editor/accessibility-statement/).",
  );
  lines.push("");
  return lines.join("\n");
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/\(.*?\)/g, (m) => m.replace(/[()]/g, ""))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function main() {
  const report = loadReport();
  const axe = loadAxe();
  const problems = checkReport(report, ROOT, axe);
  for (const p of problems) console.error(`✖ ${p}`);
  if (problems.length) process.exit(1);
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [lang, rel] of Object.entries(PAGES)) {
    const want = renderPage(report, lang, axe);
    const path = join(ROOT, rel);
    const have = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (have === want) continue;
    if (check) {
      console.error(`✖ ${rel} is out of date: run node scripts/acr.mjs`);
      stale++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, want);
      console.error(`wrote ${rel}`);
    }
  }
  if (stale) process.exit(1);
  const s = summary(report);
  console.error(`✓ ACR: ${report.criteria.length} criteria with a status — A: ${s.A.supports} supports, ${s.A["partially-supports"]} partial, ${s.A["does-not-support"]} not supported; AA: ${s.AA.supports} supports, ${s.AA["partially-supports"]} partial, ${s.AA["does-not-support"]} not supported.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
