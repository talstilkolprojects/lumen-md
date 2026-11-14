/**
 * Plan W11.S12 — the public security page, /security and /he/security,
 * written from what the repository holds: the findings register
 * (security/findings.json) and the plugin scorecards of W11.S14
 * (public/plugins/examples/scorecards/*.json). Shared by
 * scripts/security-page.mjs and its tests.
 */

const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const STATUSES = ["open", "accepted", "fixed"];

/** Problems with the findings register. */
export function findingsProblems(data) {
  const out = [];
  if (!data?.audit || typeof data.audit.external !== "boolean" || !data.audit.en?.trim() || !data.audit.he?.trim()) out.push("audit: needs external (true/false) and the status in English and Hebrew");
  if (data?.audit?.external === true && !/^https:\/\//.test(String(data.audit.report ?? ""))) out.push("audit: an external audit needs the published report (https link)");
  const ids = new Set();
  for (const f of data?.findings ?? []) {
    const w = f?.id ?? "(no id)";
    if (!/^LUM-\d{4}-\d{3}$/.test(String(f?.id))) out.push(`${w}: id must be LUM-YYYY-NNN`);
    if (ids.has(f.id)) out.push(`${w}: listed twice`);
    ids.add(f.id);
    if (!STATUSES.includes(f.status)) out.push(`${w}: status must be ${STATUSES.join(", ")}`);
    if (!SEVERITIES.includes(f.severity)) out.push(`${w}: severity must be ${SEVERITIES.join(", ")}`);
    if (!f.en?.trim() || !f.he?.trim()) out.push(`${w}: needs the finding in English and Hebrew`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.opened))) out.push(`${w}: opened must be a date`);
    if (f.status === "fixed" && !String(f.fixedBy ?? "").trim()) out.push(`${w}: a fixed finding names the PR that fixed it (fixedBy)`);
  }
  return out;
}

/** Privacy label lines for a plugin, from the permissions its manifest declares. */
export function privacyLabel(permissions, lang) {
  const L = {
    en: { "document:read": "Reads the open note", "document:write": "Changes the open note", "vault:read": "Reads notes in your vault", "vault:write": "Changes notes in your vault", "bases:read": "Reads rows of your Bases views", "bases:write": "Changes note properties (one approval per call)", "clipboard:write": "Writes to the clipboard", storage: "Keeps its own data on this device", settings: "Keeps its settings", notifications: "Shows notifications", network: (o) => `Can send data to ${o}`, none: "Collects nothing: no network access" },
    he: { "document:read": "קורא את הפתק הפתוח", "document:write": "משנה את הפתק הפתוח", "vault:read": "קורא פתקים בכספת", "vault:write": "משנה פתקים בכספת", "bases:read": "קורא שורות מתצוגות Bases", "bases:write": "משנה מאפייני פתקים (אישור לכל קריאה)", "clipboard:write": "כותב ללוח", storage: "שומר נתונים משלו במכשיר הזה", settings: "שומר את ההגדרות שלו", notifications: "מציג התראות", network: (o) => `יכול לשלוח נתונים אל ${o}`, none: "לא אוסף כלום: בלי גישה לרשת" },
  }[lang];
  const lines = [];
  for (const p of permissions) {
    if (p.startsWith("network:")) lines.push(L.network(p.slice(8)));
    else if (typeof L[p] === "string") lines.push(L[p]);
  }
  if (!permissions.some((p) => p.startsWith("network:"))) lines.push(L.none);
  return lines;
}

const T = {
  en: {
    title: "Security",
    description: "Lumen's security status in public: the external audit (none yet), the threat model, fuzzing, release provenance, every open finding, and a review scorecard with a privacy label for each plugin.",
    intro: "This page is written from the repository itself: the findings register (`security/findings.json`) and the plugin scorecards (`public/plugins/examples/scorecards/`). A test fails when the page is out of date, so an open finding can't be left off it.",
    audit: "External audit",
    threat: "Threat model",
    threatBody: "What is protected, who we defend against, and the known gaps: [Threat model](/security/threat-model/).",
    fuzz: "Fuzzing",
    fuzzBody: "The decoders are fuzzed (`npm run fuzz`, 1,000,000 inputs per decoder); how and what is covered: [Supply chain](/security/supply-chain/). Results per release are not published on this page yet.",
    slsa: "Release provenance (SLSA)",
    slsaBody: "Releases are built to carry signatures and SLSA provenance (`npm run release:sign`, `npm run release:verify`, plan W7.22); see [Supply chain](/security/supply-chain/). No signed release has been published yet: the first is 0.2.0-beta.1 (launch gate M0).",
    open: "Open findings",
    openIntro: "Every finding that is still open or accepted, with its severity. A finding leaves this list only when it is fixed, with the change that fixed it.",
    none: "No open findings.",
    cols: "| id | severity | area | finding | since |",
    plugins: "Plugin review scorecards",
    pluginsIntro: "Every version of every plugin in the registry goes through an automated review before it is listed (plan W11.S14): static analysis (eval, Function, obfuscation, minified-only bundles, undeclared network origins), its permissions against the previous version, its stylesheet (no remote `@import` or `url()`), and a public source. A version that fails is not listed; a listed version whose review failed is taken down within 24 hours. The privacy label comes from the permissions the manifest declares.",
    pcols: "| plugin | version | grade | score | privacy label |",
    report: "Report a vulnerability",
    reportBody: "Privately, as [SECURITY.md](https://github.com/talstilkol/lumen-md/blob/main/SECURITY.md) explains.",
    sev: { critical: "critical", high: "high", medium: "medium", low: "low", info: "info" },
    acc: " (accepted)",
  },
  he: {
    title: "אבטחה",
    description: "מצב האבטחה של Lumen בפומבי: ביקורת חיצונית (עוד אין), מודל האיום, fuzzing, מקור הגרסאות, כל ממצא פתוח, וכרטיס ניקוד עם תווית פרטיות לכל תוסף.",
    intro: "הדף הזה נכתב מהמאגר עצמו: רשימת הממצאים (`security/findings.json`) וכרטיסי הניקוד של התוספים (`public/plugins/examples/scorecards/`). בדיקה נכשלת כשהדף לא מעודכן, כך שאי אפשר להשמיט ממנו ממצא פתוח.",
    audit: "ביקורת חיצונית",
    threat: "מודל האיום",
    threatBody: "מה מוגן, ממי אנחנו מתגוננים, והפערים הידועים: [מודל האיום](/he/security/threat-model/).",
    fuzz: "Fuzzing",
    fuzzBody: "המפענחים עוברים fuzzing ‏(`npm run fuzz`, מיליון קלטים לכל מפענח); איך ומה מכוסה: [שרשרת האספקה](/he/security/supply-chain/). התוצאות לכל גרסה עוד לא מתפרסמות בדף הזה.",
    slsa: "מקור הגרסאות (SLSA)",
    slsaBody: "הגרסאות נבנות כך שיישאו חתימות ו-SLSA provenance ‏(`npm run release:sign`, ‏`npm run release:verify`, משימה W7.22); ראו [שרשרת האספקה](/he/security/supply-chain/). עוד לא פורסמה גרסה חתומה: הראשונה היא 0.2.0-beta.1 (שער ההשקה M0).",
    open: "ממצאים פתוחים",
    openIntro: "כל ממצא שעדיין פתוח או שהתקבל, עם החומרה שלו. ממצא יוצא מהרשימה רק כשהוא תוקן, עם השינוי שתיקן אותו.",
    none: "אין ממצאים פתוחים.",
    cols: "| מזהה | חומרה | תחום | ממצא | מאז |",
    plugins: "כרטיסי ניקוד של תוספים",
    pluginsIntro: "כל גרסה של כל תוסף ברשימה עוברת סקירה אוטומטית לפני שהיא מוצגת (משימה W11.S14): ניתוח סטטי (eval, ‏Function, הסתרת קוד, חבילה מוקטנת בלבד, יעדי רשת לא מוצהרים), ההרשאות שלה מול הגרסה הקודמת, גיליון הסגנון שלה (בלי `@import` או `url()` מרוחקים) ומקור ציבורי. גרסה שנכשלת לא מוצגת; גרסה מוצגת שהסקירה שלה נכשלה יורדת תוך 24 שעות. תווית הפרטיות נגזרת מההרשאות שהמניפסט מצהיר עליהן.",
    pcols: "| תוסף | גרסה | ציון | ניקוד | תווית פרטיות |",
    report: "דיווח על חולשה",
    reportBody: "באופן פרטי, כמו ש-[SECURITY.md](https://github.com/talstilkol/lumen-md/blob/main/SECURITY.md) מסביר.",
    sev: { critical: "קריטית", high: "גבוהה", medium: "בינונית", low: "נמוכה", info: "מידע" },
    acc: " (התקבל)",
  },
};

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The page in one language. `cards` are scorecards (W11.S14). */
export function renderSecurityPage(findings, cards, lang) {
  const t = T[lang];
  const open = findings.findings.filter((f) => f.status !== "fixed").sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.id < b.id ? -1 : 1));
  const listed = [...cards].filter((c) => c.passed).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version < b.version ? -1 : 1));
  return [
    "---",
    `title: ${t.title}`,
    `description: ${t.description}`,
    "---",
    "",
    "<!-- Written by scripts/security-page.mjs from security/findings.json and the plugin scorecards. Do not edit by hand. -->",
    "",
    t.intro,
    "",
    `## ${t.audit}`,
    "",
    findings.audit[lang],
    ...(findings.audit.external && findings.audit.report ? ["", `[${findings.audit.report}](${findings.audit.report})`] : []),
    "",
    `## ${t.threat}`,
    "",
    t.threatBody,
    "",
    `## ${t.fuzz}`,
    "",
    t.fuzzBody,
    "",
    `## ${t.slsa}`,
    "",
    t.slsaBody,
    "",
    `## ${t.open}`,
    "",
    t.openIntro,
    "",
    ...(open.length ? [t.cols, "|---|---|---|---|---|", ...open.map((f) => `| ${f.id} | ${t.sev[f.severity]}${f.status === "accepted" ? t.acc : ""} | ${cell(f.area)} | ${cell(f[lang])} | ${f.opened} |`)] : [t.none]),
    "",
    `## ${t.plugins}`,
    "",
    t.pluginsIntro,
    "",
    t.pcols,
    "|---|---|---|---|---|",
    ...listed.map((c) => `| \`${c.id}\` | ${c.version} | ${c.grade} | ${c.score} | ${cell(privacyLabel(c.permissions.declared, lang).join("; "))} |`),
    "",
    `## ${t.report}`,
    "",
    t.reportBody,
    "",
  ].join("\n");
}
