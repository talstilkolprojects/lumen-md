/**
 * Toggle a task in its note (plan 4.13): the line is rewritten only if it is
 * still the task that was shown (same line number and text); otherwise the
 * note changed meanwhile and nothing is written. Recurring tasks are only
 * marked done; the next occurrence is not created (see the docs page).
 */
import { parseTaskLine, type Task } from "./taskParser";

const todayIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The list markers and the checkbox at the start of a task line (`1. 1. [ ]` too). */
const CHECKBOX = /^([\s\t>]*(?:(?:[-*+]|[0-9]+[.)]) +)+)\[(.)\]/u;
/** The done date field, as the parser reads it. */
const DONE_FIELD = /[ \t]*✅️? *\d{4}-\d{2}-\d{2}/gu;
const BLOCK_LINK = / \^[a-zA-Z0-9-]+\s*$/u;

/**
 * The note with the task's line toggled, or null when the line no longer
 * matches. Only the checkbox and the done date change: the rest of the line
 * (field order, spacing, alternative emojis, markers) is kept byte for byte.
 */
export function toggledContent(content: string, task: Task, today = todayIso()): string | null {
  const lines = content.split("\n");
  const raw = lines[task.line];
  if (raw === undefined) return null;
  const cr = raw.endsWith("\r") ? "\r" : "";
  const line = cr ? raw.slice(0, -1) : raw;
  const now = parseTaskLine(line, task.path, task.line, task.heading);
  if (!now || now.description !== task.description || now.status !== task.status) return null;
  const box = CHECKBOX.exec(line);
  if (!box) return null;
  let rest = line.slice(box[0].length);
  let symbol: string;
  if (now.status === "DONE" || now.status === "CANCELLED") {
    symbol = " ";
    if (now.done) {
      // The field the parser read is the last one on the line.
      const all = [...rest.matchAll(DONE_FIELD)];
      const last = all[all.length - 1];
      if (last?.index !== undefined) rest = rest.slice(0, last.index) + rest.slice(last.index + last[0].length);
    }
  } else {
    symbol = "x";
    if (!now.done) {
      const field = `✅ ${today}`;
      const bl = BLOCK_LINK.exec(rest);
      if (bl) rest = `${rest.slice(0, bl.index).trimEnd()} ${field}${rest.slice(bl.index)}`;
      else rest = `${rest.trimEnd()} ${field}`;
    }
  }
  lines[task.line] = `${box[1]}[${symbol}]${rest}${cr}`;
  return lines.join("\n");
}

/** Read, toggle and write back through the vault. Returns false when the note changed. */
export async function toggleTaskInVault(task: Task): Promise<boolean> {
  const { readWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
  const content = await readWorkspaceFile(task.path);
  const next = toggledContent(content, task);
  if (next === null) return false;
  await writeWorkspaceFile(task.path, next);
  window.dispatchEvent(new CustomEvent("lumen-workspace-changed", { detail: { paths: [task.path] } }));
  return true;
}

export { todayIso };
