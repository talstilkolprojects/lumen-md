/**
 * Paths an MCP client or the CLI may name (plan W2.3).
 *
 * Every path is relative to the vault, uses `/`, and stays inside it: `..`
 * and absolute paths are refused, and so is anything under a dot folder —
 * `.lumen/` holds the permissions, the approval queue and the ledger, so a
 * client that could write there could approve its own changes.
 */
import * as path from "node:path";

export class VaultPathError extends Error {}

/** The normalised relative path, or throws `VaultPathError`. */
export function safeRel(rel: string): string {
  const raw = String(rel ?? "").replace(/\\/g, "/").trim();
  if (!raw) throw new VaultPathError("A path is required.");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new VaultPathError(`Path '${rel}' is outside the vault.`);
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new VaultPathError(`Path '${rel}' is outside the vault.`);
  if (normalized.split("/").some((part) => part.startsWith("."))) throw new VaultPathError(`Path '${rel}' is in a hidden folder; clients cannot use it.`);
  return normalized;
}

/** A note path: `safeRel` plus a Markdown/text extension (`.md` is added when there is none). */
export function notePath(rel: string): string {
  const p = safeRel(rel);
  if (/\.(md|markdown|txt)$/i.test(p)) return p;
  if (/\.[a-z0-9]{1,8}$/i.test(path.posix.basename(p))) throw new VaultPathError(`'${rel}' is not a Markdown note.`);
  return `${p}.md`;
}

export function absPath(vault: string, rel: string): string {
  return path.join(vault, ...safeRel(rel).split("/"));
}

/** Notes are .md / .markdown / .txt files outside dot folders. */
export function isNoteName(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}
