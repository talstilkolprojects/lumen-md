#!/usr/bin/env node
/**
 * Issue triage (plan 14.3). Every open issue that is not yet triaged gets:
 *
 *   labels      bug / enhancement / question / documentation from its text,
 *               plus an area label (area:editor, area:hebrew, area:ai, …)
 *   duplicates  a "possible duplicate of #N" note when another issue has
 *               nearly the same title (label: duplicate?)
 *   repro       for a bug without steps, browser or version: a comment that
 *               asks for them (label: needs-repro)
 *   plan link   the plan task it belongs to (a task number in the text, or
 *               the task whose title shares the most words with it), with
 *               the task's status from plan/plan.json
 *   triaged     the label that marks the issue as done here
 *
 * and a daily report: the issues of the last day with what they got, and
 * every open issue older than 24 hours that is still untriaged (the
 * acceptance: a new issue is triaged within 24 hours).
 *
 *   node scripts/issue-triage.mjs            dry run: prints what it would do
 *   node scripts/issue-triage.mjs --apply    writes labels and comments
 *   --json <file>                             the report as JSON too
 *
 * REST through `gh` only (GH_TOKEN in Actions). One comment per issue, found
 * again by its marker, so a rerun never comments twice. Issue text is data:
 * it is matched against word lists, never executed or sent anywhere.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MARKER = "<!-- lumen-issue-triage -->";
export const TRIAGED = "triaged";
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Labels the script may add; created when missing. */
export const LABELS = {
  bug: { color: "d73a4a", description: "Something is broken" },
  enhancement: { color: "a2eeef", description: "A new feature or an improvement" },
  question: { color: "d876e3", description: "A question, not a change request" },
  documentation: { color: "0075ca", description: "Docs are missing or wrong" },
  "needs-repro": { color: "e4e669", description: "Waiting for steps to reproduce, browser / OS and version" },
  "duplicate?": { color: "cfd3d7", description: "Possibly the same as another issue — please check" },
  [TRIAGED]: { color: "ededed", description: "Looked at by the triage script" },
  "area:editor": { color: "5319e7", description: "Editing, WYSIWYG, Markdown" },
  "area:render": { color: "5319e7", description: "Preview, blocks, diagrams, charts" },
  "area:hebrew": { color: "5319e7", description: "Hebrew, RTL, i18n" },
  "area:ai": { color: "5319e7", description: "AI, agents, local models" },
  "area:storage": { color: "5319e7", description: "Vault, files, sync, backup, history" },
  "area:security": { color: "5319e7", description: "Security, privacy, CSP, secrets" },
  "area:desktop": { color: "5319e7", description: "Tauri desktop app" },
  "area:mobile": { color: "5319e7", description: "iOS / Android, PWA" },
  "area:performance": { color: "5319e7", description: "Speed, memory, bundle size" },
  "area:plugins": { color: "5319e7", description: "Plugins, marketplace, MCP" },
  "area:export": { color: "5319e7", description: "Export, import, publishing" },
  "area:collab": { color: "5319e7", description: "Collaboration, sharing" },
};

const KIND_WORDS = {
  bug: /\b(bug|crash|crashes|broken|error|exception|fails?|failed|failure|doesn'?t work|does not work|not working|wrong|regression|freez|hang|stuck|unexpected|cannot|can'?t)\b|באג|קורס|שגיאה|לא עובד|נתקע|תקלה|שבור/i,
  enhancement: /\b(feature|request|support for|add|would be (nice|great)|wish|proposal|suggest|improve|enhancement|could you|please add|option to)\b|בקשה|תוספת|הצעה|שיפור|אפשרות|הוסיפו|נחמד אם/i,
  question: /\?\s*$|^(how|why|what|where|is it|can i|does|do i)\b|איך|למה|האם|מה ה|כיצד/i,
  documentation: /\b(docs?|documentation|readme|guide|tutorial|typo|wiki)\b|תיעוד|מדריך|הסבר/i,
};
const AREA_WORDS = {
  "area:hebrew": /hebrew|rtl|right-to-left|bidi|nikud|niqqud|arabic|i18n|translation|locale|עברית|ניקוד|תרגום|ימין לשמאל/i,
  "area:ai": /\b(ai|agent|agents|llm|ollama|gpt|claude|gemini|model|whisper|embedding|summar|transcri)\b|בינה|סוכן|מודל|תמלול|סיכום/i,
  "area:security": /security|privacy|csp|secret|token leak|password|encrypt|xss|vault lock|אבטחה|פרטיות|הצפנה|סיסמה/i,
  "area:storage": /\b(vault|opfs|indexeddb|storage|sync|backup|history|autosave|lost|data loss|folder|file system)\b|כספת|אחסון|סנכרון|גיבוי|היסטוריה|אבד|נמחק|תיקייה/i,
  "area:desktop": /\b(tauri|desktop|windows|macos|mac os|linux app|installer|dmg|msi|appimage)\b|שולחן העבודה|מק|ווינדוס/i,
  "area:mobile": /\b(ios|iphone|ipad|android|mobile|phone|pwa|home screen|capacitor|safari on)\b|נייד|טלפון|אייפון|אנדרואיד/i,
  "area:performance": /\b(slow|lag|performance|memory|freez|bundle|startup|load time|fps|jank)\b|איטי|ביצועים|זיכרון|טעינה/i,
  "area:plugins": /\b(plugin|plugins|marketplace|mcp|extension|api)\b|תוסף|תוספים/i,
  "area:export": /\b(export|import|pdf|docx|epub|latex|publish|html export|zip)\b|ייצוא|ייבוא|פרסום/i,
  "area:collab": /\b(collab|collaboration|share|sharing|realtime|real-time|y-?js|webrtc|room)\b|שיתוף|שיתופי|חדר/i,
  "area:render": /\b(preview|render|mermaid|diagram|chart|table|math|katex|code block|graphviz|image|embed)\b|תצוגה|רינדור|תרשים|טבלה|נוסחה/i,
  "area:editor": /\b(editor|wysiwyg|cursor|typing|keyboard|shortcut|autocomplete|markdown|heading|list|link|wikilink|paste|undo)\b|עורך|סמן|מקלדת|קיצור|הקלדה|קישור|ביטול/i,
};
const REPRO_WORDS = /\b(steps?( to reproduce)?|reproduc|1\.|2\.|expected|actual|version|v\d+\.\d|chrome|chromium|firefox|safari|edge|windows|macos|linux|android|ios|console|stack ?trace|screenshot|screen recording)\b|שלבים|לשחזר|גרסה|דפדפן|כרום|צילום מסך/i;

// ───────────────────────────── pure helpers ─────────────────────────────

const text = (issue) => `${issue.title ?? ""}\n${issue.body ?? ""}`;

/** The kind label, by the first family of words that matches (bug wins over question). */
export function classify(issue) {
  const t = text(issue);
  const title = issue.title ?? "";
  if (KIND_WORDS.bug.test(t)) return "bug";
  if (KIND_WORDS.enhancement.test(t)) return "enhancement";
  if (KIND_WORDS.documentation.test(t)) return "documentation";
  if (KIND_WORDS.question.test(title) || KIND_WORDS.question.test(t)) return "question";
  return null;
}

/** Up to two area labels, the ones whose words appear most often. */
export function areas(issue, max = 2) {
  const t = text(issue);
  return Object.entries(AREA_WORDS)
    .map(([label, re]) => [label, (t.match(new RegExp(re.source, re.flags + "g")) ?? []).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([label]) => label);
}

/** Words of a title, lower-cased, without punctuation and short filler words. */
export function tokens(s) {
  const stop = new Set(["the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "is", "it", "with", "when", "not", "does", "doesn't", "את", "של", "על", "עם", "לא", "אם", "זה", "גם", "או"]);
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stop.has(w)),
  );
}
export function similarity(a, b) {
  const [x, y] = [tokens(a), tokens(b)];
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
/** The most similar other issue by title, when similar enough. */
export function duplicateOf(issue, others, threshold = 0.6) {
  let best = null;
  for (const o of others) {
    if (o.number === issue.number) continue;
    const s = similarity(issue.title, o.title);
    if (s >= threshold && (!best || s > best.score)) best = { number: o.number, title: o.title, state: o.state, score: s };
  }
  return best;
}

export const needsRepro = (issue, kind) => kind === "bug" && !REPRO_WORDS.test(issue.body ?? "");

/** The plan task the issue belongs to: a task number in the text, else the title with the most words in common. */
export function planTask(issue, tasks) {
  const t = text(issue);
  const byId = new Map(tasks.map((x) => [x.id, x]));
  for (const m of t.matchAll(/(?:^|[\s(#])(\d{1,2}\.\d{1,2})(?=[\s).,:;]|$)/g)) {
    const hit = byId.get(m[1]);
    if (hit) return { ...hit, how: "number" };
  }
  let best = null;
  for (const task of tasks) {
    const s = similarity(issue.title, task.title);
    if (s >= 0.34 && (!best || s > best.score)) best = { ...task, how: "title", score: s };
  }
  return best;
}

/** What one issue gets. */
export function triage(issue, { others = [], tasks = [] } = {}) {
  const kind = classify(issue);
  const have = new Set((issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)));
  const labels = [kind, ...areas(issue)].filter(Boolean);
  const dup = duplicateOf(issue, others);
  const repro = needsRepro(issue, kind);
  const task = planTask(issue, tasks);
  if (dup) labels.push("duplicate?");
  if (repro) labels.push("needs-repro");
  labels.push(TRIAGED);
  return { number: issue.number, title: issue.title, kind, labels: labels.filter((l) => !have.has(l)), dup, repro, task };
}

const statusWord = (status = "") => (status.startsWith("✅") ? "done" : status.startsWith("⏳") ? "in progress" : "planned");

/** The one comment, in English and Hebrew, only when there is something to say. */
export function commentFor(r) {
  const en = [];
  const he = [];
  if (r.dup) {
    en.push(`This looks like it may be the same as #${r.dup.number} (${r.dup.state}): "${r.dup.title}". If it is, please add your details there; if it is not, say so and the \`duplicate?\` label comes off.`);
    he.push(`נראה שזה אולי אותו נושא כמו #${r.dup.number} (${r.dup.state === "open" ? "פתוח" : "סגור"}): "${r.dup.title}". אם כן, כדאי להוסיף את הפרטים שם; אם לא, כתבו וזה יוסר מ-\`duplicate?\`.`);
  }
  if (r.repro) {
    en.push("To look into this we need: the steps (1, 2, 3…), what you expected and what happened, the browser or app and its version (Settings → About, or the URL), and if possible a minimal note that shows it (Export → one file).");
    he.push("כדי לבדוק צריך: את השלבים (1, 2, 3…), מה ציפיתם ומה קרה, הדפדפן או האפליקציה והגרסה (הגדרות ← אודות, או הכתובת), ואם אפשר פתק מינימלי שמראה את זה (ייצוא ← קובץ אחד).");
  }
  if (r.task) {
    en.push(`Related plan task: **${r.task.id} · ${r.task.title}** (${statusWord(r.task.status)}${r.task.status ? `, ${r.task.status}` : ""}).`);
    he.push(`משימה קשורה בתוכנית: **${r.task.id} · ${r.task.title}** (${r.task.status ?? "מתוכנן"}).`);
  }
  if (!en.length) return null;
  return `${MARKER}\n${en.join("\n\n")}\n\n---\n\n${he.join("\n\n")}\n\n_Automatic triage; a person reads every issue too. Labels: ${r.labels.map((l) => `\`${l}\``).join(" ")}_`;
}

/** The daily report: the last day's issues and every older open issue still untriaged. */
export function report(issues, results, now = Date.now()) {
  const since = now - DAY_MS;
  const recent = issues.filter((i) => Date.parse(i.created_at) >= since);
  const late = issues.filter((i) => i.state === "open" && Date.parse(i.created_at) < since && !(i.labels ?? []).some((l) => (typeof l === "string" ? l : l.name) === TRIAGED));
  const byNumber = new Map(results.map((r) => [r.number, r]));
  const row = (i) => {
    const r = byNumber.get(i.number);
    const has = (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
    return `| #${i.number} | ${String(i.title).replace(/\|/g, "\\|").slice(0, 70)} | ${[...new Set([...has, ...(r?.labels ?? [])])].filter((l) => l !== TRIAGED).join(", ") || "—"} | ${r?.dup ? `#${r.dup.number}` : "—"} | ${r?.task ? r.task.id : "—"} |`;
  };
  const lines = [
    `## Issue triage: ${recent.length} new in the last 24 h, ${results.length} triaged now, ${late.length} open > 24 h without triage`,
    "",
    "| issue | title | labels | duplicate of | plan task |",
    "|---|---|---|---|---|",
    ...recent.map(row),
  ];
  if (!recent.length) lines.push("| — | no new issues | | | |");
  if (late.length) lines.push("", "### Open for more than 24 hours and not triaged", "", ...late.map((i) => `- #${i.number} ${i.title} (opened ${i.created_at.slice(0, 10)})`));
  return { markdown: lines.join("\n") + "\n", recent: recent.length, late: late.map((i) => i.number) };
}

// ───────────────────────────── GitHub ─────────────────────────────

export function restApi(repo) {
  const gh = (args, input) => {
    const out = execFileSync("gh", ["api", ...args], { encoding: "utf8", input, maxBuffer: 64 << 20, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    return out ? JSON.parse(out) : null;
  };
  const list = (path) => {
    const out = [];
    for (let page = 1; ; page++) {
      const r = gh([`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`]);
      out.push(...r);
      if (r.length < 100) return out;
    }
  };
  return {
    issues: (state = "all") => list(`repos/${repo}/issues?state=${state}`).filter((i) => !i.pull_request),
    comments: (n) => list(`repos/${repo}/issues/${n}/comments`),
    labels: () => list(`repos/${repo}/labels`).map((l) => l.name),
    createLabel: (name, { color, description }) => gh(["-X", "POST", `repos/${repo}/labels`, "--input", "-"], JSON.stringify({ name, color, description })),
    addLabels: (n, labels) => gh(["-X", "POST", `repos/${repo}/issues/${n}/labels`, "--input", "-"], JSON.stringify({ labels })),
    comment: (n, body) => gh(["-X", "POST", `repos/${repo}/issues/${n}/comments`, "--input", "-"], JSON.stringify({ body })),
  };
}

/** Run the triage against an api; `apply` writes. */
export function runTriage(api, { apply = false, tasks = [], now = Date.now(), log = console.log } = {}) {
  const all = api.issues("all");
  const open = all.filter((i) => i.state === "open");
  const todo = open.filter((i) => !(i.labels ?? []).some((l) => l.name === TRIAGED));
  const results = [];
  if (apply) {
    const have = new Set(api.labels());
    for (const [name, def] of Object.entries(LABELS)) if (!have.has(name)) api.createLabel(name, def);
  }
  for (const issue of todo) {
    const r = triage(issue, { others: all, tasks });
    const body = commentFor(r);
    const already = api.comments(issue.number).some((c) => (c.body ?? "").startsWith(MARKER));
    log(`#${issue.number} ${issue.title}: ${r.labels.join(", ")}${r.dup ? ` · dup? #${r.dup.number}` : ""}${r.repro ? " · needs repro" : ""}${r.task ? ` · plan ${r.task.id}` : ""}${already ? " (already commented)" : ""}${apply ? "" : " [dry run]"}`);
    if (apply) {
      if (r.labels.length) api.addLabels(issue.number, r.labels);
      if (body && !already) api.comment(issue.number, body);
    }
    results.push(r);
  }
  return { results, report: report(all, results, now) };
}

// ───────────────────────────── CLI ─────────────────────────────

function main(argv) {
  const apply = argv.includes("--apply");
  const repo = process.env.GITHUB_REPOSITORY ?? "talstilkol/lumen-md";
  const plan = JSON.parse(readFileSync(join(ROOT, "plan/plan.json"), "utf8"));
  const tasks = plan.phases.flatMap((p) => p.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })));
  const { results, report: rep } = runTriage(restApi(repo), { apply, tasks });
  process.stdout.write("\n" + rep.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, rep.markdown);
  const jsonAt = argv.indexOf("--json");
  if (jsonAt >= 0) {
    const file = resolve(argv[jsonAt + 1]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), apply, results, late: rep.late }, null, 2) + "\n");
  }
  if (rep.late.length) {
    console.error(`::warning::${rep.late.length} issue(s) open for more than 24 h without triage: ${rep.late.map((n) => `#${n}`).join(" ")}`);
    return apply ? 1 : 0;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(2);
  }
}
