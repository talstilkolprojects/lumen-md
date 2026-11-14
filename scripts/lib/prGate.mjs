/**
 * The rules of the PR gate (plan 0.19), as pure functions so they are unit
 * tested (src/__tests__/prGate.test.ts) and run by scripts/pr-check.mjs
 * (`npm run pr:check`), which replaces Danger.js and size-limit.
 *
 * Inputs are plain data — the PR's changed files, the added lines per file,
 * the commit messages, two package-lock.json objects — so the rules run the
 * same from the command line and in a test.
 */
import { TAKEN_DOMAIN } from "./takenDomain.mjs";

// ── Network calls must be registered in the privacy ledger ────────────────

/** A call that sends a request out of the page. */
const NETWORK_CALL = /\b(?:fetch|fetchWithRetry)\s*\(|\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\s*\(|\bsendBeacon\s*\(|\bimportScripts\s*\(/;
/** An absolute URL written in the code. */
const URL_LITERAL = /\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)(?::\d+)?/g;
/** The annotation for a call whose URL is not a literal: says which ledger rule covers it. */
export const LEDGER_NOTE = /privacy-ledger:\s*\S/;

/** Hosts the app may reach without a ledger rule: the page's own origin and the local machine. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Production source: src/ minus tests, stories and declarations. */
export function isProductionSource(file) {
  return /^src\/.+\.(?:[cm]?[jt]sx?)$/.test(file) && !/(?:^|\/)__tests__\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$/.test(file);
}

/**
 * New network calls the privacy ledger would not know about.
 *
 * `added`: { file: [{ line: number, text: string, before: string[] }] } —
 * the added lines of each changed file, with the two lines above each one.
 * `ledgerSource`: the text of src/ai/privacyLedger.ts, whose RULES name
 * every host the app reaches.
 *
 * A new call passes when every URL literal on its line names a host that
 * appears in the ledger (or the local machine), or, when the URL is not a
 * literal, when the line or one of the two above carries
 * `// privacy-ledger: <the rule or endpoint that covers it>`.
 */
export function unregisteredNetworkCalls(added, ledgerSource) {
  const out = [];
  for (const [file, lines] of Object.entries(added)) {
    if (!isProductionSource(file)) continue;
    for (const { line, text, before = [] } of lines) {
      const code = text.replace(/\/\/.*$/, "");
      if (!NETWORK_CALL.test(code)) continue;
      const hosts = [...text.matchAll(URL_LITERAL)].map((m) => m[1].toLowerCase());
      if (hosts.length) {
        const unknown = hosts.filter((h) => !LOCAL_HOSTS.has(h) && !ledgerSource.includes(h));
        if (unknown.length) out.push({ file, line, text: text.trim(), why: `host not in the privacy ledger: ${unknown.join(", ")}` });
        continue;
      }
      if ([text, ...before].some((t) => LEDGER_NOTE.test(t))) continue;
      out.push({ file, line, text: text.trim(), why: "URL is not a literal and the call has no `// privacy-ledger: …` note" });
    }
  }
  return out;
}

/**
 * Parse a unified diff (git diff -U2) into the added-lines map
 * unregisteredNetworkCalls reads. Used by `danger local` and the tests.
 */
export function addedLinesFromDiff(diff) {
  const out = {};
  let file = null;
  let next = 0;
  let recent = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : null;
      recent = [];
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      recent = [];
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+")) {
      (out[file] ??= []).push({ line: next, text: raw.slice(1), before: recent.slice(-2) });
      recent.push(raw.slice(1));
      next++;
    } else if (raw.startsWith(" ")) {
      recent.push(raw.slice(1));
      next++;
    }
  }
  return out;
}

// ── Code without tests ────────────────────────────────────────────────────

/** Changed production files when the PR touches no test at all. */
export function untestedChanges(changedFiles) {
  const prod = changedFiles.filter(isProductionSource);
  const tests = changedFiles.filter((f) => /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$|^e2e\//.test(f));
  return tests.length ? [] : prod;
}

// ── Written by an AI agent ────────────────────────────────────────────────

const AI_MARK = /Co-Authored-By:\s*(?:Claude|Codex|GitHub Copilot|ChatGPT)|Generated with \[Claude Code\]|chatgpt\.com\/codex|claude\.ai\/code\/session_/i;
export const AI_LABEL = "ai-written";

/** Does the PR body or any commit say an AI agent wrote it? */
export function writtenByAi(body, commitMessages) {
  return [body ?? "", ...commitMessages].some((t) => AI_MARK.test(t));
}

// ── Licence change ────────────────────────────────────────────────────────

const LICENCE_FAIL = /\b(?:A?GPL|SSPL|BUSL|Commons Clause|Elastic|CC-BY-NC|NonCommercial|UNLICENSED)\b/i;
const LICENCE_WARN = /\bLGPL|SEE LICENSE IN/i;

/**
 * Production packages added or changed between two package-lock.json
 * objects, with their licence and a verdict (`fail` for copyleft /
 * non-commercial / missing, `warn` for LGPL or a pointer to a file).
 */
export function licenceChanges(baseLock, headLock) {
  const base = baseLock?.packages ?? {};
  const head = headLock?.packages ?? {};
  const out = [];
  for (const [path, p] of Object.entries(head)) {
    if (!path.startsWith("node_modules/") || p.dev || p.devOptional) continue;
    const before = base[path];
    if (before && before.version === p.version && before.license === p.license) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + 13);
    const license = p.license ?? "";
    const level = !license || LICENCE_FAIL.test(license) ? "fail" : LICENCE_WARN.test(license) ? "warn" : "ok";
    out.push({ name, version: p.version, license: license || "(none)", previous: before ? `${before.version} ${before.license ?? ""}`.trim() : null, level });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Commits: GitHub Actions stay off ──────────────────────────────────────

/** Subjects without `[skip ci]`: every commit carries it, so a push never starts Actions (decision 9.11). */
export function skipCiViolations(subjects) {
  return subjects.filter((s) => !/\[skip ci\]/.test(s));
}

// ── The PR body ───────────────────────────────────────────────────────────

/** The sections every PR body has (the lane convention, CONTRIBUTING.md "Pull Requests"). */
export const REQUIRED_SECTIONS = ["## What and why", "## Definition of done (plan 0.7)", "## Local verification", "## Not verified here", "## Owner commands"];

/** Missing or empty required sections of a Markdown body. */
export function bodyProblems(body, required = REQUIRED_SECTIONS) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const out = [];
  const lines = text.split("\n");
  for (const h of required) {
    const at = lines.findIndex((l) => l.trim() === h);
    if (at < 0) {
      out.push(`missing section "${h}"`);
      continue;
    }
    const next = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
    const content = lines.slice(at + 1, next < 0 ? undefined : next).join("\n").trim();
    if (!content) out.push(`section "${h}" is empty`);
  }
  return out;
}

// ── The project's domain ──────────────────────────────────────────────────

/**
 * Added lines that name the domain the project never writes (the owner's rule): lumen + .md as a host.
 * The whole tree is checked too, by `npm run hygiene` (./takenDomain.mjs).
 */
const DOMAIN = TAKEN_DOMAIN;
export function domainMentions(added) {
  const out = [];
  for (const [file, lines] of Object.entries(added)) for (const { line, text } of lines) if (DOMAIN.test(text)) out.push({ file, line, text: text.trim().slice(0, 160) });
  return out;
}
