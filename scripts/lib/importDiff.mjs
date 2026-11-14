/**
 * Plan W11.P2 — the same export through lumen-md and through Obsidian
 * Importer (the oracle), compared. Shared by scripts/import-diff.mjs and
 * its tests.
 *
 * A vault is a Map of path → text (notes) or bytes (attachments). The
 * metrics, counted the same way on both sides:
 *   notes        .md files
 *   attachments  every other file
 *   links        internal links and embeds: [[…]], ![[…]], and [..](relative) / ![..](relative)
 *   headings     ATX headings outside code fences
 *   tasks        task-list items, open or done
 *   hebrew       Hebrew words, NFC: each word of the oracle must be in lumen-md at least as often
 *   bidi         direction marks kept (LRM, RLM, ALM, the embeddings, overrides and isolates)
 *
 * The gate: lumen-md must reach the oracle on every metric. A shortfall over
 * 1% fails, explained or not; a shortfall of 1% or less fails unless an
 * explanation names that metric. More than the oracle is never a failure.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BIDI = /[‎‏؜‪-‮⁦-⁩]/g;
const HEBREW_WORD = /[֐-׿יִ-ﭏ]+(?:["'׳״][֐-׿]+)*/g;
export const METRICS = ["notes", "attachments", "links", "headings", "tasks", "hebrew", "bidi"];
/** The largest shortfall an explanation can cover (1%). Never raise this. */
export const MAX_SHORTFALL = 0.01;

const isNote = (p) => /\.(md|markdown)$/i.test(p);
const text = (v) => (typeof v === "string" ? v : new TextDecoder().decode(v));

/** The lines of a note outside fenced code blocks. */
function outsideFences(md) {
  const out = [];
  let fence = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) out.push(line);
  }
  return out;
}

/** Front matter is not content: the metrics read the body. */
const body = (md) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/** The metrics of one vault, plus the Hebrew word counts behind `hebrew`. */
export function vaultMetrics(vault) {
  const m = { notes: 0, attachments: 0, links: 0, headings: 0, tasks: 0, hebrew: 0, bidi: 0 };
  const words = new Map();
  for (const [path, v] of vault) {
    if (!isNote(path)) {
      m.attachments++;
      continue;
    }
    m.notes++;
    const md = text(v).normalize("NFC");
    const lines = outsideFences(body(md));
    for (const line of lines) {
      if (/^\s{0,3}#{1,6}\s+\S/.test(line)) m.headings++;
      if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/.test(line)) m.tasks++;
      m.links += (line.match(/!?\[\[[^\]\n]+\]\]/g) ?? []).length;
      for (const l of line.matchAll(/!?\[[^\]\n]*\]\(<?([^)\s>]+)>?\)/g)) if (!/^[a-z][a-z0-9+.-]*:/i.test(l[1]) && !l[1].startsWith("#")) m.links++;
      m.bidi += (line.match(BIDI) ?? []).length;
      for (const w of line.match(HEBREW_WORD) ?? []) words.set(w, (words.get(w) ?? 0) + 1);
    }
  }
  m.hebrew = [...words.values()].reduce((a, b) => a + b, 0);
  return { metrics: m, words };
}

/**
 * Compare lumen-md's vault with the oracle's. `explanations` maps a metric
 * to the reason for its shortfall. Returns one row per metric and `pass`.
 */
export function compareVaults(lumen, oracle, explanations = {}) {
  const L = vaultMetrics(lumen);
  const O = vaultMetrics(oracle);
  // Hebrew is word for word: an oracle word missing in lumen-md is a shortfall even if the totals match.
  let hebrewMissing = 0;
  const missingWords = [];
  for (const [w, n] of O.words) {
    const short = n - (L.words.get(w) ?? 0);
    if (short > 0) {
      hebrewMissing += short;
      if (missingWords.length < 20) missingWords.push(w);
    }
  }
  const rows = METRICS.map((metric) => {
    const lumenN = L.metrics[metric];
    const oracleN = O.metrics[metric];
    const shortBy = metric === "hebrew" ? hebrewMissing : Math.max(0, oracleN - lumenN);
    const shortfall = oracleN ? shortBy / oracleN : 0;
    const why = String(explanations[metric] ?? "").trim();
    let status = "pass";
    let reason = shortBy ? `short by ${shortBy} (${(shortfall * 100).toFixed(2)}%)` : "";
    if (shortBy && shortfall > MAX_SHORTFALL) {
      status = "fail";
      reason += `: over ${MAX_SHORTFALL * 100}%${why ? ` (explained, but the explanation covers ≤ ${MAX_SHORTFALL * 100}% only)` : ""}`;
    } else if (shortBy && !why) {
      status = "fail";
      reason += ": not explained";
    } else if (shortBy) {
      status = "explained";
      reason += `: ${why}`;
    }
    return { metric, lumen: lumenN, oracle: oracleN, shortBy, shortfall, status, reason, ...(metric === "hebrew" && missingWords.length ? { missingWords } : {}) };
  });
  return { rows, pass: rows.every((r) => r.status !== "fail") };
}

/** The comparison as a Markdown table. */
export function diffMarkdown(r, title = "import:diff") {
  const icon = { pass: "✅", explained: "📝", fail: "❌" };
  return [
    `## ${title}: ${r.pass ? "PASS" : "FAIL"}`,
    "",
    "| metric | lumen-md | oracle | |",
    "|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.metric} | ${x.lumen} | ${x.oracle} | ${icon[x.status]} ${x.reason}${x.missingWords ? ` — missing: ${x.missingWords.join(", ")}` : ""} |`),
    "",
  ].join("\n");
}

/** A folder as a vault: notes as text, everything else as bytes. */
export function readVault(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const n of readdirSync(dir).sort()) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p).split("\\").join("/"), /\.(md|markdown)$/i.test(n) ? readFileSync(p, "utf8") : new Uint8Array(readFileSync(p)));
    }
  };
  walk(root);
  return out;
}

