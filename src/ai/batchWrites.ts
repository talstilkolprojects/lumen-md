/**
 * Applying batch results to notes (split out of batch.ts, plan W4.11; it
 * re-exports every name): frontmatter fields and tags, and the planned
 * writes for a finished job. Pure: no request, no storage.
 */

export type BatchOp = "tags" | "summary" | "translate";
/** "local": a queue this device runs through chat() (policy-routed to the local model). */
export type BatchProvider = "anthropic" | "openai" | "local";

export interface BatchItem {
  customId: string;
  path: string;
  /** Fingerprint of the text that was sent: results for a note edited since are skipped. */
  hash?: string;
}

/** Short, stable fingerprint of a note's text (FNV-1a 32-bit, hex). */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
/** Front matter keys a batch translation carries: its source note and its job. */
export const TRANSLATED_FROM = "translatedFrom";
export const TRANSLATION_JOB = "translationJob";

export interface BatchJob {
  id: string;
  provider: BatchProvider;
  model: string;
  op: BatchOp;
  /** Target language (translate). */
  lang?: string;
  createdAt: string;
  items: BatchItem[];
  status: "submitted" | "ended" | "applied" | "failed" | "expired" | "cancelled";
  /** Usage already recorded (results are re-downloaded until applied). */
  metered?: boolean;
  /** Notes (sources) whose result has already been written — skipped on a retry. */
  done?: string[];
}

/* ─── Applying results ──────────────────────────────────────────────── */

const yamlString = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());

/** Set (or replace) a top-level `key: value` line in the note's front matter, creating it when absent. */
/** True when every `[` / `{` opened in a YAML flow value is closed (quotes respected). */
function flowClosed(text: string, open: string): boolean {
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of text.slice(text.indexOf(open))) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return true;
  }
  return false;
}

export function setFrontmatterField(content: string, key: string, value: string): string {
  // `---\n---` (empty front matter) counts too.
  const fm = /^---\r?\n(?:([\s\S]*?)\r?\n)?---/.exec(content);
  const line = `${key}: ${value}`;
  if (!fm) return `---\n${line}\n---\n\n${content}`;
  const lines = fm[1] ? fm[1].split(/\r?\n/) : [];
  const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (at === -1) lines.push(line);
  else {
    // Drop the old value's continuation: indented lines, and blank lines
    // inside a block scalar / list, up to the next top-level key.
    let end = at + 1;
    while (end < lines.length && (/^\s+\S/.test(lines[end]) || (!lines[end].trim() && lines.slice(end + 1).some((l) => l.trim()) && /^\s+\S/.test(lines.slice(end + 1).find((l) => l.trim()) ?? "")))) end++;
    // A multi-line flow collection (`key: [` … `]`) ends at its closing
    // bracket, which may sit at column 0.
    const flow = /^[^:]+:\s*([[{])/.exec(lines[at]);
    if (flow && !flowClosed(lines.slice(at, end).join("\n"), flow[1])) {
      while (end < lines.length && !flowClosed(lines.slice(at, end + 1).join("\n"), flow[1])) end++;
      end = Math.min(lines.length, end + 1);
    }
    lines.splice(at, end - at, line);
  }
  return `---\n${lines.join("\n")}\n---` + content.slice(fm[0].length);
}

/** Tags from a model answer (JSON array, or comma-separated). */
export function parseTags(answer: string): string[] {
  const cleaned = answer.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = cleaned.split(/[,\n]+/);
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((t) => String(t).trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9-]/g, "-"))
    .filter((t) => t.length > 1 && t.length < 40)
    .slice(0, 7);
}

export interface PlannedWrite {
  path: string;
  content: string;
  /** A new file (translation) rather than an update. */
  created: boolean;
  /** The note the result came from. */
  source: string;
}

/** A YAML line without its trailing `# comment` (a `#` after whitespace, outside quoted scalars). */
export function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (quote === "'" && ch === "'" && line[i + 1] === "'") i++; // '' is an escaped quote
      else if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && (i === 0 || /[\s:[{,-]/.test(line[i - 1]))) quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line;
}

/** A plain or quoted YAML scalar's value (`'it''s'` → `it's`, `"a\"b"` → `a"b`). */
function yamlScalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** A top-level scalar field of the front matter, or null when absent. */
export function frontmatterField(content: string, key: string): string | null {
  const fm = /^---\r?\n(?:([\s\S]*?)\r?\n)?---/.exec(content)?.[1];
  if (!fm) return null;
  const line = fm.split(/\r?\n/).find((l) => l.startsWith(key) && new RegExp(`^${key}\\s*:`).test(l));
  return line === undefined ? null : yamlScalar(stripYamlComment(line.replace(/^[^:]+:/, "")));
}

/** Existing tags in the front matter: inline `[a, b]`, `a, b`, or a block list. */
export function frontmatterTags(content: string): string[] {
  const fm = /^---\r?\n(?:([\s\S]*?)\r?\n)?---/.exec(content)?.[1];
  if (!fm) return [];
  // Comments (`tags: [a, b] # note`) aren't part of the value.
  const lines = fm.split(/\r?\n/).map(stripYamlComment);
  const at = lines.findIndex((l) => /^tags\s*:/.test(l));
  if (at === -1) return [];
  let inline = lines[at].replace(/^tags\s*:\s*/, "").trim();
  // A flow list over several lines: `tags: [` … `]`.
  if (inline.startsWith("[")) {
    let end = at;
    while (end + 1 < lines.length && !flowClosed(lines.slice(at, end + 1).join("\n"), "[")) end++;
    inline = lines.slice(at, end + 1).join(" ").replace(/^tags\s*:\s*/, "").replace(/,\s*\]\s*$/, "]").trim();
  }
  if (inline) {
    // Split on commas outside quotes: ["a, b", c] is two tags.
    const body = inline.replace(/^\[|\]$/g, "");
    const out: string[] = [];
    for (const m of body.matchAll(/\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+)\s*(?:,|$)/g)) {
      const t = yamlScalar(m[1]);
      if (t) out.push(t);
    }
    return out;
  }
  const out: string[] = [];
  for (let i = at + 1; i < lines.length && /^\s+-\s*/.test(lines[i]); i++) out.push(yamlScalar(lines[i].replace(/^\s+-\s*/, "")));
  return out.filter(Boolean);
}

/** Existing tags plus new ones (no duplicates), written as one inline array. */
export function mergeTags(content: string, tags: readonly string[]): string {
  const all = [...new Set([...frontmatterTags(content), ...tags])];
  // Plain tags stay bare; anything YAML could misread (spaces, `:`, `#`,
  // brackets, quotes…) is quoted.
  const yaml = (t: string) => (/^[\p{L}\p{N}_./-]+$/u.test(t) && !/^[-.]/.test(t) ? t : JSON.stringify(t));
  return setFrontmatterField(content, "tags", `[${all.map(yaml).join(", ")}]`);
}

/**
 * The writes a finished job implies: tags / summary update the note's
 * front matter; translations become `<name>.<lang>.md` next to it.
 */
export function planWrites(
  job: BatchJob,
  answers: ReadonlyMap<string, string>,
  read: (path: string) => string | null,
  exists: (path: string) => boolean = (p) => read(p) !== null,
  /** Notes edited since submission are collected here (their results are skipped). */
  changed: string[] = [],
  /**
   * Every path in the workspace, when known: a retry then finds this job's
   * earlier translation among ALL `-n` siblings, even after a lower-numbered
   * one was deleted (A9). Without it, siblings are probed up to the first gap.
   */
  paths?: readonly string[],
): PlannedWrite[] {
  const out: PlannedWrite[] = [];
  const taken = new Set<string>();
  /** `base.md`, else `base-2.md`, `base-3.md`… — never an existing or planned file. */
  const freePath = (want: string) => {
    let p = want;
    for (let n = 2; exists(p) || taken.has(p.toLowerCase()); n++) p = want.replace(/\.md$/i, `-${n}.md`);
    taken.add(p.toLowerCase());
    return p;
  };
  for (const item of job.items) {
    const answer = answers.get(item.customId);
    if (!answer || job.done?.includes(item.path)) continue;
    const current = read(item.path);
    if (current === null) continue;
    // The answer is about the text that was sent: skip notes edited since.
    if (item.hash && textHash(current) !== item.hash) {
      changed.push(item.path);
      continue;
    }
    if (job.op === "translate") {
      const code = (job.lang ?? "translated").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 20);
      const want = item.path.replace(/(\.(md|markdown))?$/i, `.${code}.md`);
      // A retry of this job (its state couldn't be saved) finds the file it
      // already wrote by its markers instead of writing a `-2` copy.
      if (writtenByJob(want, item.path, job.id, read, exists, paths)) continue;
      // The markers make later batches skip this note, however many there are.
      // The path is stored exactly (no whitespace folding): retries compare it.
      let content = setFrontmatterField(answer.trim() + "\n", TRANSLATED_FROM, JSON.stringify(item.path));
      content = setFrontmatterField(content, TRANSLATION_JOB, yamlString(job.id));
      out.push({ path: freePath(want), content, created: true, source: item.path });
      continue;
    }
    if (job.op === "tags") {
      const tags = parseTags(answer);
      if (tags.length) out.push({ path: item.path, content: mergeTags(current, tags), created: false, source: item.path });
    } else {
      out.push({ path: item.path, content: setFrontmatterField(current, "summary", yamlString(answer)), created: false, source: item.path });
    }
  }
  return out;
}

/** Whether `want` (or one of its `-2`, `-3`… siblings) is the translation job `id` made of `source`. */
function writtenByJob(
  want: string,
  source: string,
  id: string,
  read: (path: string) => string | null,
  exists: (path: string) => boolean,
  paths?: readonly string[],
): boolean {
  const ours = (p: string) => {
    const text = read(p);
    return text !== null && frontmatterField(text, TRANSLATED_FROM) === source && frontmatterField(text, TRANSLATION_JOB) === id;
  };
  if (paths) {
    // `want` itself or `want` with `-<n>` before `.md`, compared case-insensitively like freePath.
    const stem = want.replace(/\.md$/i, "").toLowerCase();
    return paths.some((p) => {
      const l = p.toLowerCase();
      return l.endsWith(".md") && (l === `${stem}.md` || (l.startsWith(`${stem}-`) && /^\d+$/.test(l.slice(stem.length + 1, -3)))) && ours(p);
    });
  }
  for (let n = 2, p = want; exists(p); p = want.replace(/\.md$/i, `-${n++}.md`)) if (ours(p)) return true;
  return false;
}
