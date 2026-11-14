/**
 * The review every plugin and theme version goes through before it is
 * listed (plan W11.S14, research R6 §1.4: the bar Obsidian set in 2026 is an
 * automated review of every version, a public scorecard and declared
 * permissions). It adds to the static scan of W1.20 (./scan.ts: syntax,
 * eval and Function, dynamic import, obfuscated property access, undeclared
 * capabilities and network origins, size, signature):
 *
 *   - obfuscation: string-array decoders (`_0x…` names), dense hex/unicode
 *     escapes, and a bundle that is minified only (very long lines, no
 *     readable source next to it);
 *   - closed source: a version needs a public source repository (https),
 *     unless it lives in this repository;
 *   - permissions against the previous version: every capability added or
 *     removed is listed, an added one is a finding the reviewer sees;
 *   - CSS (a theme, or a plugin's styles): no `@import`, and no `url()` to
 *     another origin unless that origin is on the allowlist; `data:` fonts
 *     and images are fine;
 *   - the lockfile audit: `npm audit` needs the network, so a version with a
 *     lockfile is marked "audit owed" until the audit ran (never "passed").
 *
 * The result is a scorecard (JSON) per version. A version that fails is not
 * listed, and one listed whose review failed must be taken down within 24
 * hours (`overdueTakedowns`).
 */

import { parseManifest, type CapabilityRequest } from "./manifest";
import { scanPluginVersion, type ScanFinding, type ScanInput, type ScanResult } from "./scan";

export const REVIEWER = "lumen-review/1";
/** A failing version that is still listed after this long is overdue. Never lengthen it. */
export const TAKEDOWN_MS = 24 * 60 * 60 * 1000;
/** Origins a stylesheet may load from (none by default: fonts and images go in as data: or relative files). */
export const CSS_ALLOWED_ORIGINS: readonly string[] = [];

export type ReviewRule = "obfuscated" | "minified-only" | "closed-source" | "new-permission" | "css-import" | "css-remote-url" | "audit-owed";
export const REVIEW_ERRORS: ReadonlySet<ReviewRule> = new Set<ReviewRule>(["obfuscated", "minified-only", "closed-source", "css-import", "css-remote-url"]);

export interface ReviewFinding {
  rule: ReviewRule | ScanFinding["rule"];
  severity: "error" | "warning";
  detail: string;
  line?: number;
}

export interface ReviewInput extends ScanInput {
  /** A theme's stylesheet, or a plugin's styles. */
  css?: string;
  /** Readable source shipped next to a minified bundle (e.g. src/main.ts), if any. */
  source?: string;
  /** The version lives in this repository (first-party examples): its source is public by definition. */
  inRepo?: boolean;
  /** The manifest of the version before this one, to diff the permissions. */
  previousManifest?: string | unknown;
  /** The version ships a lockfile (package-lock.json / pnpm-lock.yaml). */
  hasLockfile?: boolean;
  /** The time of the review (ms); tests pass it. */
  now?: number;
}

export interface Scorecard {
  kind: "lumen-plugin-scorecard";
  v: 1;
  reviewer: typeof REVIEWER;
  id: string;
  version: string;
  reviewedAt: string;
  passed: boolean;
  /** 0–100, 0 when not passed. */
  score: number;
  grade: ScanResult["grade"];
  sha256: string;
  source: { repository: string | null; inRepo: boolean };
  permissions: { declared: string[]; added: string[]; removed: string[] };
  /** "owed" until `npm audit` ran on the lockfile; "none" without a lockfile. */
  audit: "none" | "owed";
  findings: ReviewFinding[];
  /** How long the review took here (ms). */
  durationMs: number;
}

const capIds = (caps: readonly CapabilityRequest[]): string[] => [...new Set(caps.map((c): string => c.id))].sort();

/** Obfuscation the AST scan does not see: string-array decoders and walls of escapes. */
export function obfuscationFindings(code: string, file: string): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const hexNames = code.match(/\b_0x[0-9a-f]{3,}\b/gi) ?? [];
  if (new Set(hexNames).size >= 3) out.push({ rule: "obfuscated", severity: "error", detail: `${file}: ${new Set(hexNames).size} _0x… names (a string-array decoder)` });
  const escapes = (code.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/gi) ?? []).length;
  if (escapes >= 40 && escapes / Math.max(1, code.length) > 0.02) out.push({ rule: "obfuscated", severity: "error", detail: `${file}: ${escapes} hex/unicode escapes` });
  if (/\b(?:atob|String\.fromCharCode)\s*\([^)]{0,200}\)\s*\)\s*\(/.test(code)) out.push({ rule: "obfuscated", severity: "error", detail: `${file}: decoded text called as code` });
  return out;
}

/** A bundle no one can read: minified lines and no readable source shipped with it. */
export function minifiedOnly(code: string, source: string | undefined): boolean {
  if (source?.trim()) return false;
  const lines = code.split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  return code.length > 2000 && (longest > 1000 || code.length / lines.length > 300);
}

/** `@import` and `url()` to another origin in a stylesheet. */
export function cssFindings(css: string, allowed: readonly string[] = CSS_ALLOWED_ORIGINS): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/@import\b[^;]*;?/gi)) out.push({ rule: "css-import", severity: "error", detail: m[0].trim().slice(0, 120) });
  for (const m of clean.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = m[2].trim().replace(/\\/g, "");
    if (/^data:/i.test(target) || target.startsWith("#")) continue;
    let origin: string | null = null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
      try {
        origin = new URL(target, "https://relative.invalid").origin;
      } catch {
        origin = target;
      }
    }
    if (origin && !allowed.includes(origin)) out.push({ rule: "css-remote-url", severity: "error", detail: target.slice(0, 120) });
  }
  return out;
}

const repositoryOf = (m: unknown): string | null => {
  const r = (m as { repository?: unknown } | null)?.repository;
  const url = typeof r === "string" ? r : typeof (r as { url?: unknown } | null)?.url === "string" ? (r as { url: string }).url : null;
  return url && /^https:\/\/[^\s/]+\/\S+/.test(url) ? url : null;
};

/** Review one version and return its scorecard. */
export async function reviewPluginVersion(input: ReviewInput): Promise<Scorecard> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const scan = await scanPluginVersion(input);
  const findings: ReviewFinding[] = [...scan.findings];
  let raw: unknown = input.manifest;
  try {
    raw = typeof input.manifest === "string" ? JSON.parse(input.manifest) : input.manifest;
  } catch {
    // why: the scan already reported the manifest; the repository stays unknown
  }
  for (const [code, file] of [[input.main, "main"], [input.ui, "ui"]] as const) {
    if (code === undefined) continue;
    findings.push(...obfuscationFindings(code, file));
    if (minifiedOnly(code, input.source)) findings.push({ rule: "minified-only", severity: "error", detail: `${file}: minified, with no readable source shipped` });
  }
  const repository = repositoryOf(raw);
  if (!repository && !input.inRepo) findings.push({ rule: "closed-source", severity: "error", detail: "no public source repository (manifest `repository`, https)" });
  if (input.css !== undefined) findings.push(...cssFindings(input.css));

  const declared = capIds(scan.capabilities);
  let before: string[] = [];
  if (input.previousManifest !== undefined) {
    try {
      before = capIds(parseManifest(input.previousManifest).capabilities);
    } catch {
      before = []; // why: an unreadable previous manifest: every permission counts as new
    }
  }
  const added = input.previousManifest === undefined ? [] : declared.filter((c) => !before.includes(c));
  const removed = before.filter((c) => !declared.includes(c));
  for (const c of added) findings.push({ rule: "new-permission", severity: "warning", detail: c });
  if (input.hasLockfile) findings.push({ rule: "audit-owed", severity: "warning", detail: "npm audit on the lockfile has not run (it needs the network)" });

  const errors = findings.filter((f) => f.severity === "error").length;
  const passed = scan.passed && errors === 0;
  // Each warning the review adds costs what a scan warning costs (10 points).
  const reviewWarnings = findings.slice(scan.findings.length).filter((f) => f.severity === "warning").length;
  const score = passed ? Math.max(0, scan.score - 10 * reviewWarnings) : 0;
  const grade: Scorecard["grade"] = !passed ? "F" : score >= 90 ? "A" : score >= 75 ? "B" : "C";
  const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    kind: "lumen-plugin-scorecard",
    v: 1,
    reviewer: REVIEWER,
    id: scan.id,
    version: scan.version,
    reviewedAt: new Date(input.now ?? Date.now()).toISOString(),
    passed,
    score,
    grade,
    sha256: scan.sha256,
    source: { repository, inRepo: !!input.inRepo },
    permissions: { declared, added, removed },
    audit: input.hasLockfile ? "owed" : "none",
    findings,
    durationMs: Math.round(ended - started),
  };
}

/** Listed versions whose review failed more than 24 hours ago: they must already be down. */
export function overdueTakedowns(listed: ReadonlyArray<{ id: string; version: string }>, cards: readonly Scorecard[], now: number): Scorecard[] {
  const key = (x: { id: string; version: string }) => `${x.id}@${x.version}`;
  const up = new Set(listed.map(key));
  return cards.filter((c) => !c.passed && up.has(key(c)) && now - Date.parse(c.reviewedAt) > TAKEDOWN_MS);
}
