/**
 * Google Takeout (plan W5.18), from its files only — no account connection:
 * Keep notes (Takeout/Keep/*.json, with their attachments) and documents
 * from Drive as Takeout exported them (Google Docs come as .docx by
 * default; .odt, .rtf, .html, .txt and .md work too; anything else is
 * copied as a file). Mail in Takeout is an .mbox, read by ./mbox.ts.
 */
import { safeName } from "../chats/notes";

export interface KeepNote {
  title: string;
  text: string;
  list: Array<{ text: string; checked: boolean }>;
  labels: string[];
  created: Date | null;
  edited: Date | null;
  pinned: boolean;
  archived: boolean;
  trashed: boolean;
  attachments: Array<{ path: string; type: string }>;
  links: Array<{ title: string; url: string }>;
}

interface KeepJson {
  title?: string;
  textContent?: string;
  listContent?: Array<{ text?: string; isChecked?: boolean }>;
  labels?: Array<{ name?: string }>;
  createdTimestampUsec?: number;
  userEditedTimestampUsec?: number;
  isPinned?: boolean;
  isArchived?: boolean;
  isTrashed?: boolean;
  attachments?: Array<{ filePath?: string; mimetype?: string }>;
  annotations?: Array<{ title?: string; url?: string }>;
}

const usec = (n: number | undefined) => (typeof n === "number" && n > 0 ? new Date(Math.floor(n / 1000)) : null);

export function isKeepJson(path: string, json: unknown): json is KeepJson {
  const j = json as KeepJson | null;
  return /(^|\/)Keep\//i.test(path) && !!j && typeof j === "object" && ("textContent" in j || "listContent" in j) && "userEditedTimestampUsec" in j;
}

export function readKeep(json: KeepJson): KeepNote {
  return {
    title: (json.title ?? "").trim(),
    text: json.textContent ?? "",
    list: (json.listContent ?? []).map((l) => ({ text: l.text ?? "", checked: !!l.isChecked })),
    labels: (json.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    created: usec(json.createdTimestampUsec),
    edited: usec(json.userEditedTimestampUsec),
    pinned: !!json.isPinned,
    archived: !!json.isArchived,
    trashed: !!json.isTrashed,
    attachments: (json.attachments ?? []).filter((a) => a.filePath).map((a) => ({ path: a.filePath as string, type: a.mimetype ?? "" })),
    links: (json.annotations ?? []).filter((a) => a.url).map((a) => ({ title: a.title || (a.url as string), url: a.url as string })),
  };
}

export const DOC_EXT = /\.(docx|odt|rtf|html?|txt|md|markdown)$/i;
export const isDriveFile = (path: string) => /(^|\/)(Drive|Google Drive|Google Docs)\//i.test(path);

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

export function keepNoteMarkdown(n: KeepNote, attachmentPath: (p: string) => string | null, missing: string): { name: string; content: string } {
  const first = n.text.split("\n").find((l) => l.trim())?.trim() ?? n.list[0]?.text ?? "";
  const title = n.title || first.slice(0, 60) || `Keep ${day(n.created)}`;
  const fields: string[] = ["source: \"google-keep\""];
  if (n.created) fields.push(`created: ${JSON.stringify(n.created.toISOString())}`);
  if (n.edited) fields.push(`edited: ${JSON.stringify(n.edited.toISOString())}`);
  if (n.labels.length) fields.push(`tags: [${n.labels.map((l) => JSON.stringify(l)).join(", ")}]`);
  if (n.pinned) fields.push("pinned: true");
  if (n.archived) fields.push("archived: true");
  const parts = [`# ${title.replace(/\n/g, " ")}`];
  if (n.text.trim()) parts.push(n.text.replace(/\r\n?/g, "\n").trim());
  if (n.list.length) parts.push(n.list.map((l) => `- [${l.checked ? "x" : " "}] ${l.text.replace(/\n/g, " ")}`).join("\n"));
  for (const a of n.attachments) {
    const at = attachmentPath(a.path);
    const name = a.path.split("/").pop() ?? a.path;
    parts.push(!at ? `📎 ${name} ${missing}` : /^image\//.test(a.type) || /\.(jpe?g|png|gif|webp)$/i.test(name) ? `![${name}](${encodeURI(at)})` : `📎 [${name}](${encodeURI(at)})`);
  }
  if (n.links.length) parts.push(n.links.map((l) => `- [${l.title.replace(/[[\]]/g, "")}](${l.url})`).join("\n"));
  return { name: safeName(title), content: `---\n${fields.join("\n")}\n---\n\n${parts.join("\n\n")}\n` };
}
