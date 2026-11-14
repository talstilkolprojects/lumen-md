#!/usr/bin/env node
/**
 * Plan W9.3 — one owner checklist.
 *
 * Reads every open PR body (gh) and plan/plan.json (chore/dod), pulls out each
 * owner step, groups the steps by the resource they need (Mac, second host,
 * Cloudflare, Vercel, accounts, models, devices, people, legal/decisions),
 * orders them by dependency into sessions, and writes docs/owner/checklist.md
 * (Hebrew, with an English section).
 *
 *   npm run owner:checklist                      # gh + origin/chore/dod → docs/owner/checklist.md
 *   npm run owner:checklist -- --check           # exit 1 when an open PR's owner steps are not listed
 *   npm run owner:checklist -- --prs prs.json --plan plan.json --out /tmp/c.md   # offline
 *
 * Re-running keeps every ticked box ([x]) whose step is unchanged, and drops the
 * steps of PRs that were merged or closed (the count is printed).
 * Only Node built-ins; no network except the gh / git calls for input.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT = "docs/owner/checklist.md";
const REPO = "talstilkol/lumen-md";

// ── Resource groups ──────────────────────────────────────────────────────────
// `where` is an explicit location ("on the Mac") and wins over any keyword;
// `kw` are weaker hints. Both are tried in the order of CLASSIFY_ORDER.
export const GROUPS = {
  accounts: {
    he: "חשבונות ושירותים",
    en: "Accounts and services",
    where: /\b(?:buildkite|weblate|percy|codemagic|browserstack|bluesky|zotero)\b/i,
    kw: /\b(?:buildkite|weblate|percy|codemagic|firebase|test lab|browserstack|bluesky|zotero|r2|apple developer|app store connect|play console|signpath|azure|github sponsors|sponsors|nextcloud|minio|dropbox|google drive|google cloud console|oauth|sentry|dsn|fly (?:launch|deploy|secrets)|flyctl|netlify|npm publish|npmjs|crates\.io|notion|accounts?)\b|חשבון/i,
  },
  models: {
    he: "מודלים, Hugging Face, ‏Kaggle ונתונים",
    en: "Models, Hugging Face, Kaggle and data",
    where: /\b(?:hugging ?face|kaggle)\b/i,
    kw: /\bhugging ?face|\bhf_\w*|\bhf\.co\b|\bkaggle\b|\bmodels?\b|--pin\b|\bpin(?:ned)?\b|\bgguf\b|\bonnx\b|\blora\b|\bdatasets?\b|\bflores|common voice|\bgolden\b|\bwer\b|\bcer\b|\bmos\b|\bembed|\beval(?::|\b)|מודל|סט זהב|סטי הזהב/i,
  },
  cloudflare: {
    he: "Cloudflare",
    en: "Cloudflare",
    where: /\bcloudflare\b/i,
    kw: /\bwrangler\b|\bcloudflare\b|workers\.dev|pages\.dev|durable object|\bworkers? builds\b/i,
  },
  vercel: {
    he: "Vercel",
    en: "Vercel",
    where: /\bin (?:the )?vercel\b|\bvercel →|\bvercel (?:dashboard|env)\b/i,
    kw: /\bvercel (?:env|project|dashboard|link|deploy|settings|--prod)\b|\bnpx vercel\b|\bvercel@\S+ env\b|\bin the vercel\b/i,
  },
  secondHost: {
    he: "מארח שני (מחשב שתמיד דולק)",
    en: "Second host (always-on machine)",
    where: /\bsecond host\b|\bsecond machine\b|\balways-on\b|מארח שני/i,
    kw: /\bsecond host\b|\bnightly\b|\bdocker\b|\btex live\b|\bcron\b|scheduled task|משימה מתוזמנת|הרצה יומית|\breaches hugging face\b/i,
  },
  mac: {
    he: "Mac",
    en: "Mac",
    where: /\bon (?:the |a |your |tal['’]s )?(?:gpu |m\d )?mac(?:book)?\b|\btal['’]s mac\b|\bon macos\b|\bgpu mac\b/i,
    kw: /\bmac(?:os|book)?\b|\bxcode\b|\bbrew\b|\bhomebrew\b|\bollama\b|apple silicon|\bm[1-4]\b|~\/library|mobile:ios|whisper[-.]cpp|\bmlx\b|\bgpu laptop\b|⌘/i,
  },
  devices: {
    he: "מכשירים",
    en: "Devices",
    where: /\bon (?:an? |the |your )?(?:iphone|ipad|android phone|phone|real device|physical device)\b/i,
    kw: /\biphone\b|\bipad\b|android (?:phone|device|studio)|\bphone\b|physical device|real device|talkback|voiceover|\bnvda\b|\bkindle\b|apple books|\btablet\b|apple pencil|\bstylus\b|share sheet|\bwidgets?\b|מכשיר|טלפון/i,
  },
  people: {
    he: "אנשים (בודקים, קליניקה, מתחזק שני, דוברים)",
    en: "People (testers, clinic, maintainer, native speakers)",
    where: /\brecruit|\bnative speakers?\b|\bclinic\b|קליניקה|גיוס/i,
    kw: /\btesters?\b|\bparticipants?\b|\brecruit|\braters?\b|native speakers?|\bspeaker\b|\bvolunteers?\b|\bclinic\b|\bmaintainer\b|\blawyer\b|readers with|\binterviews?\b|\b\d+ (?:users|people|writers|students|readers)\b|\bwriters\b|\binvitations\b|\boutreach\b|קליניקה|מתנדב|בודקים|דוברי|משתתפים|כותבים|דובר/i,
  },
  legal: {
    he: "משפטי והחלטות",
    en: "Legal and decisions",
    where: /\bdecisions? for the owner\b|להחלטת הבעלים|\bthe owner['’]s call\b/i,
    kw: /\blicen[cs]es?\b|\blegal\b|\bprivacy\b|\bterms\b|\bdecid|\bdecisions?\b|\bapprove\b|sign-?off|רישוי|החלטה|להחליט|משפטי|פרטיות|accessibility coordinator/i,
  },
  other: {
    he: "כל מחשב עם npm install",
    en: "Any computer with a full npm install",
    where: /$^/,
    kw: /$^/,
  },
};
/** Classification priority: the first group that matches wins. */
export const CLASSIFY_ORDER = ["people", "mac", "devices", "secondHost", "accounts", "cloudflare", "vercel", "models", "legal", "other"];
/** Suggested session order (dependency order between resources) and why. */
export const SESSION_ORDER = [
  ["accounts", "אימות חשבונות לוקח ימים, והטוקנים שלהם נדרשים לכמעט כל השאר", "Account verification takes days, and its tokens feed almost everything else"],
  ["legal", "החלטות ושליחות משפטיות מחכות לצד השני — לשלוח מוקדם", "Decisions and legal sends wait on someone else — send them early"],
  ["people", "גיוס אנשים לוקח זמן; לפתוח עכשיו ולהריץ כשמוכנים", "Recruiting takes time; start now, run when ready"],
  ["models", "צריך את HF_TOKEN מהחשבונות; ההצמדות וההורדות משמשות את ה-Mac ואת המארח השני", "Needs HF_TOKEN from accounts; the pins and downloads feed the Mac and the second host"],
  ["cloudflare", "ה-Workers וה-Pages נותנים כתובות שמשתני Vercel צריכים", "Workers and Pages give the URLs the Vercel variables need"],
  ["vercel", "משתני סביבה אחרי ש-Cloudflare נתן כתובות; פריסה אחת בסוף", "Env vars after Cloudflare gave URLs; one redeploy at the end"],
  ["secondHost", "הרצות לילה ובדיקות מול שתי הפריסות — אחרי Cloudflare ו-Vercel", "Nightly runs and two-host checks — after Cloudflare and Vercel"],
  ["mac", "ישיבה אחת על ה-Mac: מודלים אמיתיים, Xcode, בניות — אחרי הטוקנים והמראה", "One Mac sitting: real models, Xcode, builds — after the tokens and the mirror"],
  ["devices", "מכשירים בודקים בניות ופריסות שכבר קיימות — בסוף", "Devices check builds and deployments that already exist — last"],
  ["other", "בדיקות שצריכות npm install מלא; בכל מחשב, בכל זמן", "Checks that need a full npm install; any computer, any time"],
];

// ── Markdown parsing ─────────────────────────────────────────────────────────
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BOLD_HEADING = /^\s*\*\*([^*]+?)\*\*:?\s*$/;
const OWNER_HEAD = /\bowners?\b|\bowner['’]s\b|בעלים|\bTal\b|\bowed\b/i;
const OWNER_HEAD_STRONG = /\bowners?\b|\bowner['’]s\b|בעלים|\bTal\b/i;
const SKIP_HEAD = /automatic checks|\brun here\b|codeowners|delegat|made after research|made under|researched/i;
/** Review leftovers (Codex threads) that Tal delegated to Claude: listed, but marked so they can be closed without Tal. */
const DELEGATED = /\bcodex\b|discussion_r\d+/i;
const DECISION_HEAD = /decision|decide|להחלטת|החלטה|proposal|the owner['’]s call/i;
export const OWNER_LINE = new RegExp(
  [
    // "Owner:", "Owner check:", "Owner step (Mac):", "Owner, Docker:", "Tal:", "**Tal:**"
    String.raw`(?:^|[\s(—–;|*⏳>-])(?:owner(?: steps?| commands?| checks?| action)?|tal)\**\s*(?:\([^)]*\))?\s*\**\s*[:,](?![\w-])(?!\s*\d)\s*\S`,
    // "(owner)", "(owner check)", "(owner, any full TeX Live …)", "(owner / W4.25)"
    String.raw`\(owner(?: check| step| action)?\s*[),/]`,
    String.raw`\bowner check on\b`,
    String.raw`\btal should\b`,
    String.raw`\btal['’]s (?:mac|machine|call|part|job)\b`,
    String.raw`\bthe submission itself is tal`,
    String.raw`\(בעלים\)|אצל הבעלים|בעלים:|needs people \(owner`,
  ].join("|"),
  "i",
);
/** Inline lines that mention an owner but are not a step: PR intros, room/key owners. */
const INLINE_NOISE = /^\s*(?:[-*]\s+)?plan\s+\**(?:W?\d|\d)|\bowner (?:secret|token|key|id)\b|\bwrong owner\b/i;
const TRAILER = /^\s*(?:https:\/\/claude\.ai\/code\/session|_?generated (?:by|with) \[?claude|🤖 generated)/i;
const HR = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

/** The project's old domain is taken and must never be written; PR text that quotes it is redacted. */
const TAKEN_DOMAIN = new RegExp(["lumen", "\\\\?\\.", "md", "(?![-\\w])"].join(""), "g");
export const redact = (s) => String(s).replace(TAKEN_DOMAIN, "(the taken domain)");

const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, "    ").length;

/**
 * Owner sections and inline owner lines of one PR body.
 * @returns {{heading: string, decision: boolean, ownedOnly: boolean, lines: string[]}[]}
 */
export function findOwnerSections(body) {
  const lines = String(body || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let cur = null; // open section
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // A bold pseudo-heading ("**Owner steps**") ends at the first plain paragraph after a blank line.
    if (cur && cur.level === 7 && !fence && l.trim() && !/^\s/.test(l) && !LIST_ITEM.test(l) && !FENCE.test(l) && !(lines[i - 1] || "").trim() && cur.lines.some((x) => x.trim())) {
      out.push(cur);
      cur = null;
    }
    if (FENCE.test(l)) fence = !fence;
    if (!fence && !FENCE.test(l)) {
      const h = l.match(HEADING);
      const b = !h && l.match(BOLD_HEADING);
      const level = h ? h[1].length : b ? 7 : 0;
      const text = h ? h[2] : b ? b[1] : "";
      const isOwner = level && OWNER_HEAD.test(text) && !SKIP_HEAD.test(text);
      if (cur && (TRAILER.test(l) || HR.test(l) || (level && (level <= cur.level || level === 7 || isOwner)))) {
        out.push(cur);
        cur = null;
      }
      if (isOwner) {
        cur = { heading: text.replace(/\*\*/g, "").trim(), level, decision: DECISION_HEAD.test(text), ownedOnly: !OWNER_HEAD_STRONG.test(text), lines: [] };
        continue;
      }
      if (TRAILER.test(l)) continue;
    }
    if (cur) {
      cur.lines.push(l);
      continue;
    }
    // Inline owner line outside a section: the list item (with its nested lines) or table row.
    if (!fence && OWNER_LINE.test(l) && !HEADING.test(l) && !INLINE_NOISE.test(l)) {
      const block = [l];
      if (LIST_ITEM.test(l)) {
        const base = indentOf(l);
        while (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > base) block.push(lines[++i]);
      }
      out.push({ heading: "", level: 0, decision: false, ownedOnly: false, inline: true, lines: block });
    }
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.lines.some((l) => l.trim()));
}

/** Splits a section into steps: a top-level list item or paragraph, with its nested lines and code. */
export function splitSteps(section) {
  const steps = [];
  let cur = null;
  let fence = false;
  let lastBlank = false;
  const listIndents = section.lines.filter((l) => LIST_ITEM.test(l)).map(indentOf);
  const base = listIndents.length ? Math.min(...listIndents) : 0;
  const push = () => {
    if (cur && cur.join("\n").trim()) steps.push(cur.join("\n"));
    cur = null;
  };
  const SEP = /^\s*\|[\s:|-]+\|\s*$/;
  const header = new Set(section.lines.map((l, i) => (SEP.test(section.lines[i + 1] || "") ? i : -1)).filter((i) => i >= 0));
  for (const [idx, l] of section.lines.entries()) {
    if (header.has(idx) || SEP.test(l)) continue; // a table's header and separator rows
    if (FENCE.test(l)) {
      if (!fence && !cur) cur = [];
      fence = !fence;
      cur.push(l);
      lastBlank = false;
      continue;
    }
    if (fence) {
      cur.push(l);
      continue;
    }
    if (!l.trim()) {
      lastBlank = true;
      if (cur) cur.push(l);
      continue;
    }
    const isTop = LIST_ITEM.test(l) ? indentOf(l) <= base : indentOf(l) <= base && !(cur && !lastBlank);
    const prevEndsColon = cur && /:\s*$/.test(cur.filter((x) => x.trim()).at(-1) || "") && !LIST_ITEM.test(l);
    const isTableRow = /^\s*\|/.test(l);
    if ((isTop && !prevEndsColon) || isTableRow) push();
    if (!cur) cur = [];
    cur.push(l);
    lastBlank = false;
  }
  push();
  return steps.map((s) => s.replace(/\n+$/, ""));
}

const CMD_START =
  /^(?:(?:[A-Z_][A-Z0-9_]*=\S*)\s+)*(?:npm|npx|node|git|gh|bash|sh|cd|curl|brew|ollama|docker|fly|flyctl|vercel|wrangler|cargo|pip|pipx|python3?|export|keytool|gcloud|firebase|latexmk|openssl|xcrun|xcodebuild|make|rustup|apt|sudo|shasum|huggingface-cli|hf|kaggle|bk|buildkite-agent|percy|unzip|tar|wget|mkdir|cp|mv|security|tauri|whisper-cli|ssh|scp|rsync)\b/;

/** Exact commands of a step: every fenced block line, and inline code that reads as a command. */
export function extractCommands(text) {
  const cmds = [];
  let fence = false;
  for (const l of text.split("\n")) {
    if (FENCE.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      if (l.trim()) cmds.push(l.replace(/^\s{0,8}/, "").replace(/\s+$/, ""));
      continue;
    }
    for (const m of l.matchAll(/`([^`]+)`/g)) {
      const c = m[1].trim();
      if (CMD_START.test(c) || /^[A-Z_][A-Z0-9_]*=\S+\s+\S/.test(c)) cmds.push(c);
    }
  }
  return [...new Set(cmds)];
}

/** One readable line for a step: markdown stripped, code blocks removed. */
export function summarize(text, max = 320, fallback = "") {
  let fence = false;
  const keep = [];
  for (const l of text.split("\n")) {
    if (FENCE.test(l)) {
      fence = !fence;
      continue;
    }
    if (!fence && l.trim()) keep.push(l.trim());
  }
  let s = keep
    .join(" ")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+(?:[-*+])\s+/g, " · ")
    .replace(/^\|\s*|\s*\|\s*$/g, "")
    .replace(/\s*\|\s*/g, " — ")
    .replace(/\*\*/g, "")
    .replace(/⏳\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return s || fallback || "(ראו את הפקודות)";
}

/** Primary resource group plus the others the step also touches. */
export function classify(text, context = "", { decision = false } = {}) {
  if (decision) return { group: "legal", also: alsoGroups(text, "legal") };
  for (const pass of ["where", "kw"]) {
    for (const g of CLASSIFY_ORDER) if (GROUPS[g][pass].test(text)) return { group: g, also: alsoGroups(text, g) };
  }
  if (context) {
    for (const g of CLASSIFY_ORDER) if (GROUPS[g].where.test(context)) return { group: g, also: alsoGroups(text, g) };
  }
  return { group: "other", also: [] };
}
function alsoGroups(text, primary) {
  return CLASSIFY_ORDER.filter((g) => g !== primary && g !== "other" && (GROUPS[g].where.test(text) || GROUPS[g].kw.test(text)));
}

// ── Plan ─────────────────────────────────────────────────────────────────────
export const allTasks = (plan) => (plan?.phases || []).flatMap((p) => p.tasks || []);
const TASK_ID = /\b(W\d+\.\d+|\d{1,2}\.\d{1,2})\b/g;

/** Task ids a PR names: the title's parentheses first, then "Plan **X**" in the body. */
export function taskIdsOf(pr, known) {
  const ids = [];
  for (const m of String(pr.title || "").matchAll(/\(([^()]*)\)/g)) for (const t of m[1].matchAll(TASK_ID)) ids.push(t[1]);
  if (!ids.length) {
    const m = String(pr.body || "").match(/\bplan\s+\*\*([^*]+)\*\*/i);
    if (m) for (const t of m[1].matchAll(TASK_ID)) ids.push(t[1]);
  }
  return [...new Set(ids)].filter((id) => !known || known.has(id));
}

const OWNER_STATUS = /\(בעלים\)|אצל הבעלים|בעלים:/;
/** Owner steps written in plan statuses ("(בעלים)", "אצל הבעלים"). */
export function planStatusSteps(plan) {
  const out = [];
  for (const t of allTasks(plan)) {
    const s = String(t.status || "");
    if (!OWNER_STATUS.test(s)) continue;
    const segs = s.split(/;|(?<=\))\s*\.\s|\s—\s|\n/).map((x) => x.trim()).filter((x) => OWNER_STATUS.test(x));
    const prs = [...s.matchAll(/#(\d{2,4})\b/g)].map((m) => Number(m[1]));
    for (const seg of segs) out.push({ task: t.id, title: t.title || "", prs: [...new Set(prs)], text: seg.replace(/^.*?(?=חסר:)/, "") });
  }
  return out;
}

/** The plan's owner list (15.x): one step each. */
export function planOwnerItems(plan) {
  return (plan?.owner || []).map((o) => {
    const details = String(o.details || "");
    const cmds = extractCommands(details).slice(0, 6);
    return { id: o.id, title: o.title || "", time: o.time || "", priority: o.priority || "", dep: o.dep || [], opens: o.opens || [], details, cmds };
  });
}

// ── Model ────────────────────────────────────────────────────────────────────
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
export const stepId = (text) => createHash("sha1").update(norm(text)).digest("hex").slice(0, 10);
export const isTrain = (pr) => /^verify\//.test(pr.headRefName || "") || /do not merge \(train/i.test(pr.title || "");

/**
 * Collects every owner step from the PR bodies and the plan.
 * @returns {{steps: object[], ownerPrs: number[], skipped: object[]}}
 */
export function collect({ prs, plan }) {
  const tasks = allTasks(plan);
  const known = new Set([...tasks.map((t) => t.id), ...(plan?.owner || []).map((o) => o.id)]);
  const byId = new Map();
  const ownerPrs = new Set();
  const skipped = [];
  const add = (key, step) => {
    const prev = byId.get(key);
    if (prev) {
      for (const p of step.prs) if (!prev.prs.includes(p)) prev.prs.push(p);
      for (const t of step.tasks) if (!prev.tasks.includes(t)) prev.tasks.push(t);
      return prev;
    }
    byId.set(key, step);
    return step;
  };
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (isTrain(pr)) {
      if (findOwnerSections(pr.body).length) skipped.push({ number: pr.number, why: "integration train (aggregates other PRs' bodies)" });
      continue;
    }
    const taskIds = taskIdsOf(pr, known);
    for (const sec of findOwnerSections(pr.body)) {
      const context = [sec.heading, sec.lines.join("\n")].join("\n");
      for (const raw of splitSteps(sec)) {
        if (sec.ownedOnly && !OWNER_LINE.test(raw)) continue; // an "owed" list: keep only the owner's lines
        if (/^(?:none|nothing|no owner|אין)\b/i.test(summarize(raw))) continue; // None for this PR.
        const { group, also } = classify(raw + "\n" + sec.heading, context + "\n" + pr.title, { decision: sec.decision });
        add(stepId(raw), {
          id: stepId(raw),
          source: "pr",
          prs: [pr.number],
          tasks: [...taskIds],
          heading: sec.heading || "(inline)",
          text: redact(summarize(raw, 320, sec.heading)),
          cmds: extractCommands(raw).map(redact),
          refs: [...new Set([...raw.matchAll(/#(\d{2,4})\b/g)].map((m) => Number(m[1])))].filter((n) => n !== pr.number),
          group,
          also,
          notes: [],
          delegated: group === "legal" && DELEGATED.test(raw),
        });
        ownerPrs.add(pr.number);
      }
    }
  }
  const steps = [...byId.values()];
  // Plan statuses: a note on the PR's steps when it has some, else a step of its own.
  for (const ps of planStatusSteps(plan)) {
    const host = steps.find((s) => s.source === "pr" && (s.tasks.includes(ps.task) || s.prs.some((p) => ps.prs.includes(p))));
    if (host) {
      if (!host.notes.includes(ps.text)) host.notes.push(`${ps.task}: ${ps.text}`);
      if (!host.tasks.includes(ps.task)) host.tasks.push(ps.task);
      continue;
    }
    const { group, also } = classify(ps.text, ps.title);
    const key = stepId(`plan:${ps.task}:${ps.text}`);
    add(key, { id: key, source: "plan", prs: ps.prs, tasks: [ps.task], heading: "plan.json status", text: summarize(ps.text), cmds: extractCommands(ps.text), refs: ps.prs, group, also, notes: [] });
  }
  for (const o of planOwnerItems(plan)) {
    const { group, also } = classify(`${o.title}\n${o.details.slice(0, 1500)}`, "");
    const key = stepId(`owner:${o.id}`);
    add(key, { id: key, source: "owner", prs: [], tasks: [o.id], heading: "plan.json owner", text: `${o.title}${o.time ? ` (${o.time})` : ""}`, cmds: o.cmds, refs: [], group, also, notes: [], priority: o.priority, dep: o.dep, opens: o.opens });
  }
  return { steps: [...byId.values()], ownerPrs: [...ownerPrs].sort((a, b) => a - b), skipped };
}

/** What finishing a step unblocks: its tasks' verification and the tasks that depend on them. */
export function unblocks(step, plan) {
  const tasks = allTasks(plan);
  const title = (id) => tasks.find((t) => t.id === id)?.title || (plan?.owner || []).find((o) => o.id === id)?.title || "";
  const own = step.tasks.map((id) => `${id}${title(id) ? ` (${title(id).slice(0, 70)})` : ""}`);
  const down = new Set(step.opens || []);
  for (const t of tasks) if ((t.dep || []).some((d) => step.tasks.includes(d)) && !step.tasks.includes(t.id)) down.add(t.id);
  for (const o of plan?.owner || []) if ((o.dep || []).some((d) => step.tasks.includes(d))) down.add(o.id);
  return { own, down: [...down].slice(0, 8), more: Math.max(0, down.size - 8) };
}

/** Sessions in SESSION_ORDER; inside a session, steps whose dependencies come first. */
export function order(steps, plan) {
  const tasks = allTasks(plan);
  const depOf = (s) => {
    const deps = new Set();
    const taskDeps = new Set([...s.tasks.flatMap((id) => tasks.find((t) => t.id === id)?.dep || []), ...(s.dep || [])]);
    for (const o of steps) {
      if (o === s) continue;
      if (o.prs.some((p) => s.refs.includes(p)) || o.tasks.some((t) => taskDeps.has(t))) deps.add(o.id);
    }
    return deps;
  };
  const deps = new Map(steps.map((s) => [s.id, depOf(s)]));
  const sessionIdx = new Map(SESSION_ORDER.map(([g], i) => [g, i]));
  const prio = (s) => (/P0/.test(s.priority || "") ? 0 : 1);
  const key = (s) => [prio(s), s.source === "owner" ? 0 : 1, s.prs[0] ?? 9999, s.tasks[0] || ""];
  const cmp = (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
  const byGroup = new Map(SESSION_ORDER.map(([g]) => [g, []]));
  for (const s of steps) byGroup.get(s.group).push(s);
  const position = new Map();
  const sessions = [];
  for (const [g, he, en] of SESSION_ORDER) {
    const list = byGroup.get(g);
    const inGroup = new Set(list.map((s) => s.id));
    const done = new Set();
    const ordered = [];
    const pending = [...list].sort(cmp);
    while (pending.length) {
      let i = pending.findIndex((s) => [...deps.get(s.id)].every((d) => !inGroup.has(d) || done.has(d)));
      if (i < 0) i = 0; // a cycle: keep the sort order
      const [s] = pending.splice(i, 1);
      done.add(s.id);
      ordered.push(s);
    }
    ordered.forEach((s, i) => position.set(s.id, `${sessionIdx.get(g) + 1}.${i + 1}`));
    sessions.push({ group: g, whyHe: he, whyEn: en, steps: ordered });
  }
  for (const s of steps) {
    s.after = [...deps.get(s.id)].map((d) => position.get(d)).filter(Boolean).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    s.late = s.after.filter((p) => Number(p.split(".")[0]) > Number(position.get(s.id).split(".")[0]));
    s.pos = position.get(s.id);
  }
  return sessions;
}

// ── Rendering ────────────────────────────────────────────────────────────────
/** Ticked ids in an existing checklist. */
export function previousState(md) {
  const done = new Set();
  const ids = new Set();
  for (const m of String(md || "").matchAll(/^\s*- \[([ xX])\].*?<!-- id:([0-9a-f]{10})/gm)) {
    ids.add(m[2]);
    if (m[1] !== " ") done.add(m[2]);
  }
  return { done, ids };
}

const prLink = (n) => `[#${n}](https://github.com/${REPO}/pull/${n})`;
const fenceFor = (lines) => (lines.some((l) => l.includes("```")) ? "~~~~" : "```");

export function render(model, plan, { previous = "", generated = "", source = "" } = {}) {
  const sessions = order(model.steps, plan);
  const prev = previousState(previous);
  const total = model.steps.length;
  const removed = [...prev.ids].filter((id) => !model.steps.some((s) => s.id === id)).length;
  const counts = sessions.map((s) => [s.group, s.steps.length, new Set(s.steps.flatMap((x) => x.prs)).size]);
  const ticked = model.steps.filter((s) => prev.done.has(s.id)).length;
  const L = [];
  L.push("<!-- Generated by `npm run owner:checklist` (scripts/owner-checklist.mjs, plan W9.3). Edit only the [ ] boxes; a re-run keeps them. -->");
  L.push('<div dir="rtl">', "");
  L.push("# רשימת הבעלים — כל צעדי הבעלים במקום אחד", "");
  L.push(`נוצר: ${generated || "—"} · מקור: ${source || "gh + plan/plan.json"} · ${total} צעדים מ-${model.ownerPrs.length} PR-ים פתוחים ומ-plan.json · ${ticked} סומנו כבוצעו${removed ? ` · ${removed} צעדים ירדו מאז הריצה הקודמת (PR מוזג/נסגר או שהגוף השתנה)` : ""}.`, "");
  L.push("איך משתמשים: עוברים על הישיבות לפי הסדר; בכל ישיבה כל מה שצריך את אותו משאב. מסמנים `[x]` כשצעד בוצע. `npm run owner:checklist` מרענן את הרשימה ושומר את הסימונים; `npm run owner:checklist -- --check` נכשל כשיש PR פתוח שצעדי הבעלים שלו לא כאן.", "");
  L.push("## סיכום לפי משאב", "", "| # | ישיבה | צעדים | PR-ים | למה בסדר הזה |", "|---|---|---|---|---|");
  sessions.forEach((s, i) => L.push(`| ${i + 1} | ${GROUPS[s.group].he} | ${s.steps.length} | ${counts[i][2]} | ${s.whyHe} |`));
  L.push(`| | **סה״כ** | **${total}** | **${model.ownerPrs.length}** | |`, "");
  if (model.skipped.length) L.push(`לא נכללו (רכבות אינטגרציה שמעתיקות גופים של PR-ים אחרים): ${model.skipped.map((s) => prLink(s.number)).join(", ")}.`, "");
  sessions.forEach((sess, i) => {
    if (!sess.steps.length) return;
    const del = sess.steps.filter((s) => s.delegated).length;
    L.push(`## ישיבה ${i + 1} — ${GROUPS[sess.group].he} (${sess.steps.length})`, "", `${sess.whyHe}.${del ? ` ${del} מהצעדים כאן הם ממצאי סקירה שהואצלו ל-Claude (מסומנים „הואצל“).` : ""}`, "");
    for (const s of sess.steps) {
      const box = prev.done.has(s.id) ? "x" : " ";
      const from = [s.prs.map(prLink).join(", "), s.tasks.join(", ")].filter(Boolean).join(" · ") || "plan.json";
      L.push(`- [${box}] **${s.pos}** ${from} — ${s.text} <!-- id:${s.id} prs:${s.prs.join(",")} -->`);
      if (s.cmds.length) {
        const f = fenceFor(s.cmds);
        L.push("", `  ${f}sh`, ...s.cmds.map((c) => `  ${c}`), `  ${f}`, "");
      } else L.push("  - פקודה: אין פקודה מדויקת ב-PR — הצעד כתוב במילים למעלה.");
      const u = unblocks(s, plan);
      L.push(`  - משחרר: ${u.own.length ? `אימות ${u.own.join("; ")}` : s.prs.length ? `אימות ${s.prs.map((n) => `#${n}`).join(", ")}` : "—"}${u.down.length ? `; ואחריו ${u.down.join(", ")}${u.more ? ` ועוד ${u.more}` : ""}` : ""}`);
      if (s.after.length) L.push(`  - אחרי: ${s.after.join(", ")}${s.late.length ? ` (⚠ ${s.late.join(", ")} בישיבה מאוחרת יותר — לעשות אותם קודם)` : ""}`);
      if (s.delegated) L.push("  - הואצל: ממצא סקירה (Codex) שטל הסמיך את Claude להחליט בו — אפשר לסגור בלי טל");
      if (s.also.length) L.push(`  - נוגע גם ב: ${s.also.map((g) => GROUPS[g].he).join(", ")}`);
      for (const n of s.notes) L.push(`  - בתוכנית: ${summarize(n, 240)}`);
      L.push(`  - סעיף מקור: ${s.heading}`);
    }
    L.push("");
  });
  L.push("</div>", "");
  // English section
  L.push("## English", "");
  L.push(`Generated ${generated || "—"} from ${source || "gh + plan/plan.json"}: **${total} owner steps** from **${model.ownerPrs.length} open PRs** and plan.json, grouped by the resource they need and ordered into sessions. Each step above has its exact command, the PR and task it comes from, what it unblocks, and the steps it must come after (\`after: 3.2\` = session 3, step 2). Tick \`[x]\` when done; \`npm run owner:checklist\` refreshes the list and keeps the ticks; \`npm run owner:checklist -- --check\` fails when an open PR's owner steps are missing.`, "");
  L.push("| # | Session | Steps | PRs | Why in this order |", "|---|---|---|---|---|");
  sessions.forEach((s, i) => L.push(`| ${i + 1} | ${GROUPS[s.group].en} | ${s.steps.length} | ${counts[i][2]} | ${s.whyEn} |`));
  L.push(`| | **Total** | **${total}** | **${model.ownerPrs.length}** | |`, "");
  const delegated = model.steps.filter((s) => s.delegated).length;
  if (delegated) L.push(`${delegated} of the legal/decision steps are leftover review (Codex) threads that Tal delegated to Claude; they are marked "הואצל" and can be closed without Tal.`, "");
  L.push("PRs per session:", "");
  sessions.forEach((s, i) => {
    const prs = [...new Set(s.steps.flatMap((x) => x.prs))].sort((a, b) => a - b);
    const plans = s.steps.filter((x) => !x.prs.length).flatMap((x) => x.tasks);
    if (s.steps.length) L.push(`- **${i + 1}. ${GROUPS[s.group].en}:** ${[prs.map((n) => `#${n}`).join(", "), plans.length ? `plan ${plans.join(", ")}` : ""].filter(Boolean).join("; ")}`);
  });
  L.push("");
  return redact(L.join("\n"));
}

/** --check: every open PR with owner steps, and every step, is in the file. */
export function check(model, md) {
  const { ids } = previousState(md);
  const listedPrs = new Set([...String(md || "").matchAll(/<!-- id:[0-9a-f]{10} prs:([\d,]*) -->/g)].flatMap((m) => m[1].split(",").filter(Boolean).map(Number)));
  const missingPrs = model.ownerPrs.filter((n) => !listedPrs.has(n));
  const missingSteps = model.steps.filter((s) => !ids.has(s.id));
  const stalePrs = [...new Set(missingSteps.flatMap((s) => s.prs))].filter((n) => !missingPrs.includes(n)).sort((a, b) => a - b);
  return { ok: !missingPrs.length && !missingSteps.length, missingPrs, missingSteps: missingSteps.length, stalePrs };
}

// ── Inputs ───────────────────────────────────────────────────────────────────
function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
/** Open PRs: `gh pr list` (GraphQL), or the REST API page by page when GraphQL is not available. */
export function loadPrs() {
  try {
    return JSON.parse(sh("gh", ["pr", "list", "--repo", REPO, "--state", "open", "--json", "number,title,body,headRefName", "--limit", "500"]));
  } catch {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const arr = JSON.parse(sh("gh", ["api", `repos/${REPO}/pulls?state=open&per_page=100&page=${page}`]));
      for (const p of arr) out.push({ number: p.number, title: p.title, body: p.body || "", headRefName: p.head?.ref || "" });
      if (arr.length < 100) break;
    }
    return out;
  }
}
export function loadPlan() {
  for (const ref of ["origin/chore/dod", "chore/dod"]) {
    try {
      return { plan: JSON.parse(sh("git", ["show", `${ref}:plan/plan.json`])), from: `${ref}:plan/plan.json` };
    } catch {
      /* next */
    }
  }
  return { plan: JSON.parse(readFileSync(resolve(ROOT, "plan/plan.json"), "utf8")), from: "plan/plan.json" };
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = resolve(ROOT, arg("--out") || DEFAULT_OUT);
  const prs = arg("--prs") ? JSON.parse(readFileSync(resolve(arg("--prs")), "utf8")) : loadPrs();
  const { plan, from } = arg("--plan") ? { plan: JSON.parse(readFileSync(resolve(arg("--plan")), "utf8")), from: arg("--plan") } : loadPlan();
  const model = collect({ prs, plan });
  const previous = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (argv.includes("--check")) {
    const r = check(model, previous);
    if (r.ok) {
      console.log(`owner:checklist ok — ${model.steps.length} steps from ${model.ownerPrs.length} PRs are listed in ${arg("--out") || DEFAULT_OUT}`);
      return 0;
    }
    if (!previous) console.error(`owner:checklist: ${arg("--out") || DEFAULT_OUT} does not exist`);
    if (r.missingPrs.length) console.error(`owner:checklist: ${r.missingPrs.length} open PR(s) with owner steps are not listed: ${r.missingPrs.map((n) => `#${n}`).join(", ")}`);
    if (r.stalePrs.length) console.error(`owner:checklist: owner steps changed in ${r.stalePrs.map((n) => `#${n}`).join(", ")}`);
    console.error(`owner:checklist: ${r.missingSteps} step(s) missing — run \`npm run owner:checklist\``);
    return 1;
  }
  const generated = arg("--date") || new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const md = render(model, plan, { previous, generated, source: `${prs.length} open PRs (${arg("--prs") ? arg("--prs") : "gh"}) + ${from}` });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  const sessions = order(model.steps, plan);
  console.log(`owner:checklist → ${arg("--out") || DEFAULT_OUT}: ${model.steps.length} steps, ${model.ownerPrs.length} PRs`);
  for (const s of sessions) console.log(`  ${GROUPS[s.group].en.padEnd(40)} ${String(s.steps.length).padStart(4)} steps  ${String(new Set(s.steps.flatMap((x) => x.prs)).size).padStart(4)} PRs`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
