/**
 * Plan W8.6: every security-sensitive file has an owner in
 * `.github/CODEOWNERS`, worked out from the code rather than from memory.
 * Review 8 (RR8-481-1) found export doors, criticMarkup, the render
 * pipeline, frame sandboxes and main.tsx missing from the hand-kept list:
 * the file that isn't listed is the one a leak goes through.
 *
 * A file is sensitive when it is shipped code (not a test, a fixture or the
 * docs) and its path or its text shows one of the RULES below: crypto, an
 * export door, a sanitizer, a frame sandbox, CSP or security headers, a
 * network call, redaction, criticMarkup, or the Markdown-to-HTML pipeline
 * and its raw-HTML sinks.
 *
 * A sensitive file that CODEOWNERS does not cover must be in the exceptions
 * list (`security/codeowners-exceptions.json`), each entry with a reason and
 * an expiry date no more than MAX_EXCEPTION_DAYS ahead. An expired, undated
 * or unexplained exception fails like a missing owner.
 *
 * Pure functions; scripts/codeowners-coverage.mjs and scripts/pr-check.mjs
 * read the files and the git tree.
 */
import { codeownersMatch } from "./humanReview.mjs";

export const EXCEPTIONS_FILE = "security/codeowners-exceptions.json";
/** An exception is a promise to fix soon, not a permanent opt-out. */
export const MAX_EXCEPTION_DAYS = 90;

/** Where shipped code lives. Everything else (scripts, docs, e2e, eval) is tooling. */
const SHIPPED = [
  /^src\//,
  /^src-tauri\/(?:src|vault|keychain|capabilities|[^/]+\/src)\//,
  /^src-tauri\/tauri\.conf\.json$/,
  /^(?:edge-workers|sync-server|api-server|marketplace-server|mcp-server|extension|mobile|ios|android)\//,
  /^packages\/[^/]+\/src\//,
  /^public\/(?:_headers|[^/]+\.js)$/,
  /^[^/]+\.html$/,
  /^(?:vercel\.json|netlify\.toml|vite\.config\.ts)$/,
  /^netlify\//,
  /^deploy\//,
  /^scripts\/(?:headers\.mjs|tauri-signing\.mjs|lib\/tauriSigning\.mjs)$/,
];
/** Not shipped even inside a shipped folder (and `*Strings.ts`, which by convention holds only UI text). */
const NOT_SHIPPED = [/(?:^|\/)__tests__\//, /(?:^|\/)__mocks__\//, /(?:^|\/)fixtures?\//, /\.(?:test|spec|eval|bench|stories)\.[cm]?[jt]sx?$/, /\.d\.ts$/, /(?:^|\/)i18n\/(?:locales|lazy)\//, /^src\/help\/generated\//, /^src\/i18n\/[^/]+\.json$/, /[a-z]Strings\.ts$/];
/** Text and code files the content rules read. */
const READABLE = /\.(?:[cm]?[jt]sx?|rs|java|kt|swift|html|json|toml)$|(?:^|\/)_headers$/;

/**
 * id → { label, path?: RegExp (on the repository path), content?: RegExp (on the text) }.
 * Order is the order the report lists them.
 */
export const RULES = [
  {
    id: "crypto",
    label: "Cryptography (keys, ciphers, signatures)",
    path: /(?:^|\/)(?:e2ee|crypto[^/]*|[^/]*encryption[^/]*|keychain|[^/]*signing[^/]*|secretStore[^/]*)(?:\/|$)/i,
    content: /\bsubtle\.(?:encrypt|decrypt|deriveKey|deriveBits|importKey|exportKey|sign|verify|wrapKey|unwrapKey|generateKey)\b|\bcreate(?:Cipheriv|Decipheriv|Hmac|Sign|Verify)\b|\bpbkdf2\b|\bargon2\w*\b|\bxchacha\w*|\bchacha20\w*|["']AES-GCM["']|\baes_gcm\b|\blibsodium\b|@noble\/(?:ciphers|hashes|curves)/i,
  },
  {
    id: "export",
    label: "Export and publish doors (must call prepareForExport)",
    path: /(?:^|\/)[^/]*(?:export|publish)[^/]*(?:\/|$)/i,
    content: /\bprepareForExport\b|\bexportReady\b/,
  },
  {
    id: "sanitizer",
    label: "Sanitising untrusted content",
    path: /(?:^|\/)[^/]*(?:saniti[sz]|trustedTypes|purif)[^/]*$/i,
    content: /\bDOMPurify\b|["']dompurify["']|rehype-sanitize|hast-util-sanitize|\btrustedTypes\.createPolicy\b/,
  },
  {
    id: "frame",
    label: "Frame sandboxes",
    path: /(?:^|\/)[^/]*sandbox[^/]*$/i,
    content: /<iframe\b|\bsrcdoc\b|\bsandbox\s*=\s*["'`{]|\.sandbox\b|createElement\(\s*["'`]iframe["'`]\)|\ballow-(?:scripts|same-origin|popups)\b|\bguardFrames\b/,
  },
  {
    id: "csp",
    label: "CSP and security headers",
    path: /(?:^|\/)(?:[^/]*csp[^/]*|_headers|headers\.[cm]?[jt]s|vercel\.json|netlify\.toml)$/i,
    content: /Content-Security-Policy|\b(?:connect|script|frame|worker|default)-src\b|X-Frame-Options|Strict-Transport-Security|Cross-Origin-(?:Opener|Embedder)-Policy/,
  },
  {
    id: "network",
    label: "Network calls (what may leave the device)",
    content: /(?<![\w$.])fetch\s*\(|\bwindow\.fetch\b|\bglobalThis\.fetch\b|\bfetchWithRetry\s*\(|new\s+WebSocket\s*\(|new\s+EventSource\s*\(|\bXMLHttpRequest\b|\bsendBeacon\s*\(|\breqwest::|\bureq::|\bHttpURLConnection\b|\bURLSession\b/,
  },
  {
    id: "redaction",
    label: "Redaction and PII",
    path: /(?:^|\/)[^/]*(?:redact|pii)[^/]*(?:\/|$)/i,
    content: /\bredact[A-Za-z]*\s*\(/,
  },
  {
    id: "criticMarkup",
    label: "criticMarkup (hidden edits in the preview)",
    path: /(?:^|\/)[^/]*criticMarkup[^/]*$/i,
  },
  {
    id: "pipeline",
    label: "Markdown-to-HTML pipeline and raw-HTML sinks",
    path: /^src\/renderer\/[^/]*pipeline[^/]*$/i,
    content: /\bdangerouslySetInnerHTML\b|\.(?:inner|outer)HTML\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(|rehype-raw|\brehypeRaw\b|\ballowDangerousHtml\b/,
  },
];

/** Is `file` (repository path, POSIX) shipped code that the rules look at? */
export function inScope(file) {
  return SHIPPED.some((r) => r.test(file)) && !NOT_SHIPPED.some((r) => r.test(file));
}

/** Source with whole-line comments taken out, so a file that only mentions CSP or fetch in its docs is not flagged. */
export function codeOnly(file, text) {
  if (text == null || !/\.(?:[cm]?[jt]sx?|rs|java|kt|swift)$/.test(file)) return text;
  return text
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
    .join("\n");
}

/** Rule ids that make `file` sensitive (empty: not sensitive). `text` may be null for an unreadable file. */
export function classify(file, text) {
  if (!inScope(file)) return [];
  text = codeOnly(file, text);
  const hits = [];
  for (const r of RULES) {
    if (r.path?.test(file)) hits.push(r.id);
    else if (text != null && r.content && READABLE.test(file) && r.content.test(text)) hits.push(r.id);
  }
  return hits;
}

/** Is `file` covered by a CODEOWNERS entry with at least one owner (the last match wins, as on GitHub)? */
export function ownedBy(file, entries) {
  let last = null;
  for (const e of entries) if (codeownersMatch(e.pattern, file)) last = e;
  return last && last.owners.length ? last : null;
}

/**
 * The exceptions list → { entries: Map(path → { reason, expires }), problems: string[] }.
 * Each entry: { "path": "...", "reason": "...", "expires": "YYYY-MM-DD" }.
 */
export function parseExceptions(text, today = new Date()) {
  const problems = [];
  const entries = new Map();
  if (text == null || String(text).trim() === "") return { entries, problems };
  let list;
  try {
    list = JSON.parse(text);
  } catch (e) {
    return { entries, problems: [`${EXCEPTIONS_FILE} is not valid JSON: ${e.message}`] };
  }
  if (!Array.isArray(list)) return { entries, problems: [`${EXCEPTIONS_FILE} must be a JSON array of { path, reason, expires }.`] };
  const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (const [i, x] of list.entries()) {
    const where = `${EXCEPTIONS_FILE}[${i}]${x && typeof x.path === "string" ? ` (${x.path})` : ""}`;
    if (!x || typeof x.path !== "string" || !x.path) {
      problems.push(`${where}: no path.`);
      continue;
    }
    if (typeof x.reason !== "string" || x.reason.trim().length < 10) problems.push(`${where}: no reason (say why it has no owner yet, in a sentence).`);
    const m = typeof x.expires === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(x.expires) : null;
    const exp = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
    if (!m || Number.isNaN(exp) || new Date(exp).getUTCDate() !== +m[3]) problems.push(`${where}: no expiry date (YYYY-MM-DD).`);
    else if (exp < day) problems.push(`${where}: expired on ${x.expires}. Give the file an owner in .github/CODEOWNERS, or renew the exception with a new reason.`);
    else if (exp - day > MAX_EXCEPTION_DAYS * 86400000) problems.push(`${where}: expires ${x.expires}, more than ${MAX_EXCEPTION_DAYS} days ahead.`);
    entries.set(x.path, { reason: x.reason, expires: x.expires, ok: !problems.some((p) => p.startsWith(where)) });
  }
  return { entries, problems };
}

/**
 * The coverage of `files` ([{ path, text }]) by CODEOWNERS `entries` and the exceptions.
 * → { sensitive: [{ file, rules, owner }], uncovered: [{ file, rules }], excepted: [{ file, rules, reason, expires }], stale: string[], problems: string[] }
 */
export function coverage(files, entries, exceptionsText, today = new Date()) {
  const ex = parseExceptions(exceptionsText, today);
  const sensitive = [];
  const uncovered = [];
  const excepted = [];
  const seen = new Set();
  for (const { path, text } of files) {
    const rules = classify(path, text);
    if (!rules.length) continue;
    seen.add(path);
    const owner = ownedBy(path, entries);
    sensitive.push({ file: path, rules, owner: owner?.pattern ?? null });
    if (owner) continue;
    const e = ex.entries.get(path);
    if (e?.ok) excepted.push({ file: path, rules, reason: e.reason, expires: e.expires });
    else uncovered.push({ file: path, rules });
  }
  // An exception for a file that is gone, owned or not sensitive any more is noise: drop it.
  const stale = [...ex.entries.keys()].filter((p) => !seen.has(p) || sensitive.some((s) => s.file === p && s.owner));
  return { sensitive, uncovered, excepted, stale, problems: ex.problems };
}

/** A CODEOWNERS line for each uncovered file, ready to paste. */
export function suggestedLines(uncovered, owner = "@talstilkol") {
  const w = Math.max(40, ...uncovered.map((u) => u.file.length + 2));
  return uncovered.map((u) => `/${u.file}`.padEnd(w) + ` ${owner}`);
}
