/**
 * Daily digest (T33): what changed in the vault since the last digest — a
 * short note with links to the changed notes, their headings, and the open
 * tasks in them. Deterministic (no model needed), so it works offline and
 * under every AI policy.
 */
import type { WorkspaceEntry } from "../../storage/workspace";

export interface DigestInput {
  since: number;
  now: number;
  /** Changed notes with their content. */
  notes: Array<{ entry: WorkspaceEntry; content: string }>;
  lang: string;
  formatDate: (ms: number) => string;
}

const L = {
  en: { title: "Digest", since: "Changes since", changed: "Changed notes", tasks: "Open tasks", none: "Nothing changed since the last digest.", more: "more" },
  he: { title: "סיכום", since: "שינויים מאז", changed: "פתקים שהשתנו", tasks: "משימות פתוחות", none: "שום דבר לא השתנה מאז הסיכום הקודם.", more: "נוספים" },
};

const MD_EXT = /\.(md|markdown)$/i;
const stem = (p: string) => p.replace(/^.*\//, "").replace(MD_EXT, "");

/** A wiki link to the note by its vault path, so same-named notes in different folders stay apart. */
function wikiLink(path: string): string {
  const target = path.replace(MD_EXT, "");
  const name = stem(path);
  return target === name ? `[[${name}]]` : `[[${target}|${name}]]`;
}

/** The Markdown without fenced code blocks (``` or ~~~), whose lines are examples, not content. */
export function withoutFences(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m.index + m[0].length).trim()) fence = null;
      continue;
    }
    if (m && !(m[1][0] === "`" && line.slice(m.index + m[0].length).includes("`"))) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function openTasks(md: string): string[] {
  return [...withoutFences(md).matchAll(/^\s*[-*] \[ \] (.+)$/gm)].map((m) => m[1].trim());
}

export function firstHeading(md: string): string | null {
  return /^#{1,3} (.+)$/m.exec(withoutFences(md))?.[1].trim() ?? null;
}

export function buildDigest(input: DigestInput): string {
  const t = input.lang === "he" ? L.he : L.en;
  const notes = [...input.notes].sort((a, b) => b.entry.modified - a.entry.modified);
  const out: string[] = [`# ${t.title} — ${input.formatDate(input.now)}`, "", `${t.since} ${input.formatDate(input.since)}.`, ""];
  if (!notes.length) {
    out.push(t.none);
    return out.join("\n") + "\n";
  }
  out.push(`## ${t.changed} (${notes.length})`, "");
  for (const n of notes.slice(0, 50)) {
    const h = firstHeading(n.content);
    out.push(`- ${wikiLink(n.entry.path)}${h && h !== stem(n.entry.path) ? ` — ${h}` : ""}`);
  }
  if (notes.length > 50) out.push(`- … +${notes.length - 50} ${t.more}`);
  const tasks = notes.flatMap((n) => openTasks(n.content).map((task) => ({ task, note: wikiLink(n.entry.path) })));
  if (tasks.length) {
    out.push("", `## ${t.tasks} (${tasks.length})`, "");
    for (const x of tasks.slice(0, 40)) out.push(`- [ ] ${x.task} ← ${x.note}`);
    if (tasks.length > 40) out.push(`- … +${tasks.length - 40} ${t.more}`);
  }
  return out.join("\n") + "\n";
}

/* ── The digest note (the vault.digest command) ─────────────────────── */

/** The folder names a digest has been written to by default (English / Hebrew UI). */
export const DEFAULT_DIGEST_FOLDERS = ["Digests", "סיכומים"] as const;

/**
 * The digest folder: the one the first digest used, kept from then on, so a
 * language switch doesn't start a second folder (and a second note for the
 * same day). Only a vault without a stored folder takes the UI language's.
 */
export function digestFolder(stored: string | null | undefined, lang: string): string {
  const s = stored?.trim().replace(/^\/+|\/+$/g, "");
  if (s && !s.startsWith(".") && !s.split("/").includes("..")) return s;
  return lang === "he" ? DEFAULT_DIGEST_FOLDERS[1] : DEFAULT_DIGEST_FOLDERS[0];
}

export interface DigestIO {
  list(): Promise<WorkspaceEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, body: string): Promise<void>;
}

export type DigestResult =
  /** `body` is the note's full content; `written` false when nothing new was added. */
  | { ok: true; path: string; body: string; written: boolean }
  /** Some notes could not be read: nothing written, the checkpoint must stay. */
  | { ok: false; failed: string[] };

/**
 * Build the digest of everything changed since `since` and save it to
 * `<folder>/<YYYY-MM-DD>.md`. A second digest on the same day is appended
 * to that day's note (never replacing it — it may hold the earlier part of
 * the day, or the user's edits); an empty one adds nothing. If a changed
 * note cannot be read, nothing is written, so the caller keeps its
 * checkpoint and the note is retried next time.
 */
export async function writeDigest(
  io: DigestIO,
  o: { since: number; now: number; lang: string; folder: string; formatDate: (ms: number) => string },
): Promise<DigestResult> {
  const all = await io.list();
  const d = new Date(o.now);
  const path = `${o.folder}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.md`;
  // Digests are never "changed notes": nothing in the digest folder, and in
  // the other language's default folder only the day notes an older version
  // wrote there (`<folder>/YYYY-MM-DD.md`) — the user's own notes in a folder
  // of that name still count.
  const isOldDigest = (p: string) => DEFAULT_DIGEST_FOLDERS.some((f) => f !== o.folder && new RegExp(`^${f}/\\d{4}-\\d{2}-\\d{2}\\.md$`).test(p));
  const entries = all.filter((e) => e.modified > o.since && MD_EXT.test(e.path) && !e.path.startsWith(".") && !e.path.startsWith(`${o.folder}/`) && !isOldDigest(e.path));
  const failed: string[] = [];
  const notes = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      content: await io.read(entry.path).catch(() => {
        failed.push(entry.path);
        return "";
      }),
    })),
  );
  let existing: string | null = null;
  if (all.some((e) => e.path === path)) {
    existing = await io.read(path).catch(() => {
      failed.push(path);
      return null;
    });
  }
  if (failed.length) return { ok: false, failed };
  const digest = buildDigest({ since: o.since, now: o.now, notes, lang: o.lang, formatDate: o.formatDate });
  if (existing !== null && !notes.length) return { ok: true, path, body: existing, written: false };
  const body = existing !== null ? `${existing.trimEnd()}\n\n---\n\n${digest}` : digest;
  await io.write(path, body);
  return { ok: true, path, body, written: true };
}
