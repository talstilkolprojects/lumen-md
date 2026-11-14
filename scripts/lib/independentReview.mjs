/**
 * Plan W6.11 (weaknesses E13, E56): every pull request that touches a
 * sensitive path (the ones `.github/CODEOWNERS` lists, plan W4.28) needs an
 * independent review receipt for its head commit before it is merged. That
 * includes the integration fixes an integration train (verify/*) makes in
 * sensitive code: the train's own PR needs a receipt too.
 *
 * The receipt is written by a reviewer that did not write the change and has
 * no write access to its branch. It is posted on the PR as a comment with a
 * fenced `lumen-review` JSON block, or kept as a JSON file (offline):
 *
 *   {
 *     "format": "lumen-review", "version": 1,
 *     "pr": 495,                                  (optional)
 *     "head": "<40-hex sha of the reviewed head commit>",
 *     "author": "<lane or agent that wrote the change>",
 *     "reviewer": "<lane or agent that reviewed it; not the author>",
 *     "access": "read-only",                      (the reviewer could not push to the branch)
 *     "date": "<ISO time>",
 *     "files": ["src/sync/e2ee/lan/rpc.ts", "/src/sync/e2ee/"],   (paths or CODEOWNERS patterns covered)
 *     "attackTests": [{ "path": "src/__tests__/x.test.ts", "result": "6/6 pass", "failsWithoutFix": 3 }],
 *     "findings": [{ "id": "E56-1", "severity": "medium", "status": "fixed", "summary": "…", "fix": "<sha or patch>" }],
 *     "verdict": "approve"                        (or "changes-requested")
 *   }
 *
 * Valid for a PR only when: the head is the PR's head now (a new push makes
 * every older receipt stale), reviewer ≠ author, access is read-only, every
 * sensitive file is covered, at least one attack test is listed, no finding
 * of severity critical or high is still open, and the verdict is approve.
 *
 * Who may post a receipt (review 14.11): only a comment by an account with
 * write access to the repository (GitHub's author_association OWNER,
 * MEMBER or COLLABORATOR) counts. On a public repository anyone can
 * comment, and a stranger's `lumen-review` block must not open the gate.
 *
 * Signed receipts (review 14.11): every lane posts as the same GitHub
 * account, so the account can't show that the reviewer isn't the author.
 * When `security/reviewers.json` exists it lists each reviewer's Ed25519
 * public key, and a receipt then counts only when its `signature` (base64,
 * over the receipt without `signature`, keys sorted: canonicalJson) verifies
 * with the key of the reviewer it names. Keys are made and receipts signed
 * with scripts/review-sign.mjs; the private key stays with the reviewer.
 *
 * This is the agents' gate; the person's gate is the `human-reviewed` label
 * (./humanReview.mjs). Both apply. Pure functions; pr-check.mjs reads git,
 * files and `gh api`.
 */

import { createPublicKey, verify } from "node:crypto";
import { codeownersMatch } from "./humanReview.mjs";

export const REVIEW_FORMAT = "lumen-review";
export const REVIEW_VERSION = 1;
export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
export const FINDING_STATUSES = ["open", "fixed", "accepted"];
const BLOCKING = new Set(["critical", "high"]);

/** Comment authors whose receipts count: accounts with write access (GitHub author_association). */
export const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
/** `files` entries that name the whole repository instead of what was read. */
const CATCH_ALL = new Set(["*", "**", "/", "/*", "/**", "**/*", "/**/*", "."]);

const isSha = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/** Every `lumen-review` block in a Markdown text → parsed objects, or { error } for a block that isn't JSON. */
export function extractReceipts(text) {
  const out = [];
  const re = /```lumen-review[^\n]*\n([\s\S]*?)```/g;
  for (const m of String(text ?? "").matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch (e) {
      out.push({ error: `a lumen-review block is not JSON (${e.message})` });
    }
  }
  return out;
}

/** The shape alone → a list of problems (empty: well formed). */
export function receiptProblems(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["not an object"];
  if (r.error) return [r.error];
  const p = [];
  if (r.format !== REVIEW_FORMAT) p.push(`format must be "${REVIEW_FORMAT}"`);
  if (r.version !== REVIEW_VERSION) p.push(`version must be ${REVIEW_VERSION}`);
  if (!isSha(r.head)) p.push("head must be a full 40-character commit sha");
  if (!nonEmpty(r.author)) p.push("author is missing");
  if (!nonEmpty(r.reviewer)) p.push("reviewer is missing");
  if (nonEmpty(r.author) && nonEmpty(r.reviewer) && r.author.trim().toLowerCase() === r.reviewer.trim().toLowerCase()) p.push("the reviewer is the author: the review must be independent");
  if (r.access !== "read-only") p.push('access must be "read-only" (the reviewer may not push to the branch)');
  if (!nonEmpty(r.date) || Number.isNaN(Date.parse(r.date))) p.push("date must be an ISO time");
  if (!Array.isArray(r.files) || !r.files.length || !r.files.every(nonEmpty)) p.push("files must list the reviewed paths");
  else {
    const all = r.files.filter((f) => CATCH_ALL.has(f.trim()));
    if (all.length) p.push(`files must name what was read: ${all.map((f) => `"${f}"`).join(", ")} covers the whole repository`);
  }
  if (!Array.isArray(r.attackTests) || !r.attackTests.length || !r.attackTests.every((t) => t && nonEmpty(t.path) && nonEmpty(t.result))) p.push("attackTests must list at least one attack test, each with path and result");
  if (!Array.isArray(r.findings)) p.push("findings must be a list (empty when there are none)");
  else
    r.findings.forEach((f, i) => {
      if (!f || !nonEmpty(f.id)) p.push(`finding ${i + 1}: id is missing`);
      if (!f || !SEVERITIES.includes(f.severity)) p.push(`finding ${i + 1}: severity must be one of ${SEVERITIES.join(", ")}`);
      if (!f || !FINDING_STATUSES.includes(f.status)) p.push(`finding ${i + 1}: status must be one of ${FINDING_STATUSES.join(", ")}`);
    });
  if (r.verdict !== "approve" && r.verdict !== "changes-requested") p.push('verdict must be "approve" or "changes-requested"');
  return p;
}

/** JSON with object keys sorted at every level: the bytes a receipt's signature covers. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The bytes a reviewer signs: the receipt without its `signature`. */
export function signedBytes(r) {
  const { signature: _omit, ...rest } = r;
  void _omit;
  return Buffer.from(canonicalJson(rest), "utf8");
}

/**
 * `security/reviewers.json` text → { keys: Map(reviewer lower-case → KeyObject), problems }.
 * Shape: { "reviewers": { "<name>": { "publicKey": "<PEM or base64 SPKI DER, Ed25519>" } } }.
 */
export function parseReviewers(text) {
  const keys = new Map();
  const problems = [];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { keys, problems: [`security/reviewers.json is not JSON (${e.message})`] };
  }
  for (const [name, entry] of Object.entries(doc?.reviewers ?? {})) {
    try {
      const pk = String(entry?.publicKey ?? "");
      const key = pk.includes("BEGIN") ? createPublicKey(pk) : createPublicKey({ key: Buffer.from(pk, "base64"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") throw new Error(`a ${key.asymmetricKeyType} key, not Ed25519`);
      keys.set(name.trim().toLowerCase(), key);
    } catch (e) {
      problems.push(`reviewer ${name}: unusable public key (${e.message})`);
    }
  }
  return { keys, problems };
}

/** Does the receipt carry a valid signature by the reviewer it names? → problems (empty: signed). */
export function signatureProblems(r, reviewers) {
  const key = reviewers.keys.get(String(r.reviewer ?? "").trim().toLowerCase());
  if (!key) return [`reviewer ${r.reviewer} is not in security/reviewers.json`];
  if (typeof r.signature !== "string" || !r.signature) return ["it is not signed (scripts/review-sign.mjs sign)"];
  let ok = false;
  try {
    ok = verify(null, signedBytes(r), key, Buffer.from(r.signature, "base64"));
  } catch {
    ok = false;
  }
  return ok ? [] : [`its signature does not verify with ${r.reviewer}'s key (changed after signing, or signed by someone else)`];
}

/**
 * PR comments → receipts the gate considers. A comment by an account without
 * write access is listed with the reason it doesn't count.
 *   comments: [{ id, user, association, body }]
 * → [{ source, receipt, rejected? }]
 */
export function commentReceipts(comments) {
  const out = [];
  for (const c of comments ?? []) {
    for (const receipt of extractReceipts(c.body)) {
      const source = `comment${c.id ? ` ${c.id}` : ""} by @${c.user ?? "?"}`;
      const trusted = TRUSTED_ASSOCIATIONS.includes(String(c.association ?? "").toUpperCase());
      out.push(trusted ? { source, receipt } : { source, receipt, rejected: `@${c.user ?? "?"} has no write access to the repository (${c.association ?? "unknown"}), so its receipt does not count` });
    }
  }
  return out;
}

/** Sensitive files the receipt does not cover (its `files` are paths or CODEOWNERS patterns). */
export function uncovered(sensitive, files) {
  return sensitive.map((s) => s.file).filter((file) => !files.some((f) => f === file || codeownersMatch(f, file)));
}

/** One receipt against the PR's head and its sensitive files → problems (empty: it counts). `reviewers`: parseReviewers(...) or null (no registry: signatures not required). */
export function receiptFor(r, head, sensitive, reviewers = null) {
  const p = receiptProblems(r);
  if (p.length) return p;
  if (reviewers) p.push(...signatureProblems(r, reviewers));
  if (head && r.head !== head) p.push(`it is for \`${r.head.slice(0, 9)}\`, not the head \`${head.slice(0, 9)}\`: the commits after it were not reviewed`);
  const missing = uncovered(sensitive, r.files);
  if (missing.length) p.push(`it does not cover ${missing.length} sensitive file${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 5).map((f) => `\`${f}\``).join(", ")}${missing.length > 5 ? " …" : ""}`);
  const open = r.findings.filter((f) => BLOCKING.has(f.severity) && f.status === "open");
  if (open.length) p.push(`${open.length} critical or high finding${open.length === 1 ? " is" : "s are"} open: ${open.map((f) => f.id).join(", ")}`);
  if (r.verdict !== "approve") p.push(`the verdict is "${r.verdict}"`);
  return p;
}

/**
 * The verdict for one PR (or one local checkout).
 *   sensitive: sensitiveChanges(...)
 *   receipts: [{ source: string, receipt: object, rejected?: string }] (PR comments and --review files)
 *   ctx: { head: sha (the PR's head, or this checkout's HEAD), strict: boolean (--pr given, or receipts given), reviewers?: parseReviewers(...) | null }
 * → { status: "ok" | "warn" | "fail", lines: string[] }
 */
export function independentReviewVerdict(sensitive, receipts, ctx) {
  if (!sensitive.length) return { status: "ok", lines: ["No sensitive path (`.github/CODEOWNERS`) changed."] };
  const n = `${sensitive.length} sensitive file${sensitive.length === 1 ? "" : "s"}`;
  if (!receipts.length) {
    const how = "An independent reviewer (not the author, no write access) posts a `lumen-review` receipt for the head commit (docs: contributing/independent-review).";
    return ctx.strict ? { status: "fail", lines: [`${n} changed and no review receipt was found. ${how}`] } : { status: "warn", lines: [`${n} changed. ${how} Before merging, run with \`--pr <number>\` or \`--review <file>\`; it fails until a valid receipt is there.`] };
  }
  const lines = [];
  let good = null;
  for (const { source, receipt, rejected } of receipts) {
    if (rejected) {
      lines.push(`- ${source}: not counted — ${rejected}.`);
      continue;
    }
    const p = receiptFor(receipt, ctx.head, sensitive, ctx.reviewers ?? null);
    if (!p.length) {
      good ??= { source, receipt };
      continue;
    }
    lines.push(`- ${source}: not counted — ${p.join("; ")}.`);
  }
  if (good) {
    const r = good.receipt;
    const counts = SEVERITIES.map((s) => [s, r.findings.filter((f) => f.severity === s).length]).filter(([, c]) => c).map(([s, c]) => `${c} ${s}`);
    return {
      status: "ok",
      lines: [
        `Reviewed at \`${r.head.slice(0, 9)}\` by ${r.reviewer} (author ${r.author}, read-only), ${r.date}: ${r.attackTests.length} attack test${r.attackTests.length === 1 ? "" : "s"}, findings ${counts.length ? counts.join(", ") : "none"}, none critical or high open; ${ctx.reviewers ? "signature verified" : "unsigned (no security/reviewers.json)"}.`,
        ...(lines.length ? ["", "Other receipts:", ...lines] : []),
      ],
    };
  }
  return { status: "fail", lines: [`${n} changed and no receipt counts for the head \`${String(ctx.head ?? "").slice(0, 9)}\`:`, ...lines] };
}

/** A receipt as the PR comment that carries it. */
export function receiptComment(r) {
  return [`Independent review (plan W6.11) of \`${String(r.head).slice(0, 9)}\` by ${r.reviewer}: **${r.verdict}**.`, "", "```lumen-review", JSON.stringify(r, null, 2), "```"].join("\n");
}
