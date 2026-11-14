/**
 * Mail → notes (plan W5.18): messages grouped into threads (Message-ID,
 * In-Reply-To and References; without them, the subject without Re:/Fwd:/
 * השב:/הועבר: prefixes), one note per thread, oldest message first, with
 * frontmatter (subject, participants, dates, labels) and attachments copied
 * next to the notes.
 */
import { displayName, type MailMessage } from "./mime";
import { safeName } from "../chats/notes";

export interface MailNote {
  path: string;
  content: string;
  messages: number;
}

const PREFIX = /^\s*((re|fw|fwd|aw|wg|tr|rv|sv|vs|השב|תשובה|הועבר|העבר|רד|ﺭﺩ|رد|إعادة توجيه|توجيه)\s*(\[\d+\])?\s*[:：]\s*)+/i;

export function threadSubject(s: string): string {
  return s.replace(PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Threads in order of their first message. */
export function groupThreads(messages: MailMessage[]): MailMessage[][] {
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(i, r);
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  const byId = new Map<string, number>();
  const bySubject = new Map<string, number>();
  messages.forEach((m, i) => {
    parent.set(i, i);
    if (m.messageId && !byId.has(m.messageId)) byId.set(m.messageId, i);
  });
  messages.forEach((m, i) => {
    let linked = false;
    for (const ref of [m.inReplyTo, ...m.references]) {
      const j = ref ? byId.get(ref) : undefined;
      if (j !== undefined) {
        union(i, j);
        linked = true;
      }
    }
    const subj = threadSubject(m.subject);
    if (!linked && subj && !m.inReplyTo && !m.references.length) {
      // No headers to follow: the same subject is the same thread.
      const j = bySubject.get(subj);
      if (j !== undefined) union(i, j);
    }
    if (subj && !bySubject.has(subj)) bySubject.set(subj, i);
  });
  const groups = new Map<number, MailMessage[]>();
  messages.forEach((m, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), m]));
  const t = (m: MailMessage) => m.date?.getTime() ?? 0;
  return [...groups.values()].map((g) => g.sort((a, b) => t(a) - t(b))).sort((a, b) => t(a[0]) - t(b[0]));
}

export interface ThreadRenderOptions {
  /** HTML → Markdown (src/storage/fileFormats htmlToMarkdown in the app). */
  htmlToMarkdown: (html: string) => string;
  /** Where an attachment of message `i` was copied (relative to the import folder). */
  attachmentPath: (m: MailMessage, index: number) => string;
  noSubject: string;
  /** Local time for a date (the app formats in the user's zone). */
  formatDate: (d: Date) => string;
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const IMAGE = /^image\//;

function body(m: MailMessage, o: ThreadRenderOptions): string {
  const text = m.text?.trim() ? m.text : m.html ? o.htmlToMarkdown(m.html) : "";
  return text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function fm(fields: Record<string, string | number | string[]>): string {
  return `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : typeof v === "number" ? v : JSON.stringify(v)}`)
    .join("\n")}\n---\n`;
}

export function renderThread(thread: MailMessage[], o: ThreadRenderOptions): MailNote {
  const first = thread[0];
  const subject = first.subject.trim() || o.noSubject;
  const people = [...new Set(thread.map((m) => displayName(m.from)).filter(Boolean))];
  const labels = [...new Set(thread.flatMap((m) => m.labels))];
  const sections = thread.map((m) => {
    const head = `## ${displayName(m.from) || "?"} · ${m.date ? o.formatDate(m.date) : "?"}`;
    const meta = [m.to && `**To:** ${m.to}`, m.cc && `**Cc:** ${m.cc}`].filter(Boolean).join("  \n");
    const files = m.attachments.map((a, i) => {
      const at = o.attachmentPath(m, i).split("/").map(encodeURIComponent).join("/");
      const label = a.name.replace(/[[\]]/g, "");
      return IMAGE.test(a.type) ? `![${label}](${at})` : `📎 [${label}](${at})`;
    });
    return [head, meta, body(m, o), files.join("\n")].filter(Boolean).join("\n\n");
  });
  const content = `${fm({ source: "mail", subject, participants: people, from: iso(first.date), to: iso(thread[thread.length - 1].date), ...(labels.length ? { labels } : {}), messages: thread.length })}\n# ${subject}\n\n${sections.join("\n\n")}\n`;
  return { path: `${safeName(subject)}${first.date ? ` (${iso(first.date)})` : ""}.md`, content, messages: thread.length };
}
