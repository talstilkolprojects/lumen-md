/**
 * Paths an MCP client or the CLI may name (plan W2.3).
 *
 * Every path is relative to the vault, uses `/`, and stays inside it: `..`
 * and absolute paths are refused, and so is anything under a dot folder —
 * `.lumen/` holds the permissions, the approval queue and the ledger, so a
 * client that could write there could approve its own changes.
 */
import { promises as fs } from "node:fs";
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

/**
 * The real file a client's path names, after links (review 21, M1). `safeRel`
 * checks the spelling only; a link in the vault (`cfg -> .lumen`, or one to a
 * folder outside the vault) made by the user or a sync tool would otherwise
 * carry a read or an approved write out of the vault or into `.lumen/`. The
 * deepest part of the path that exists is resolved, the rest is appended, and
 * the result must stay under the vault's own real path and outside dot
 * folders. Notes reached through a link that stays inside the vault work.
 */
export async function realVaultPath(vault: string, rel: string): Promise<string> {
  const abs = absPath(vault, rel);
  const root = await fs.realpath(vault);
  const rest: string[] = [];
  let probe = abs;
  let real: string;
  for (;;) {
    try {
      real = path.join(await fs.realpath(probe), ...rest);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
  const inside = path.relative(root, real);
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new VaultPathError(`Path '${rel}' leads outside the vault through a link.`);
  }
  if (inside.split(path.sep).some((part) => part.startsWith("."))) {
    throw new VaultPathError(`Path '${rel}' leads into a hidden folder through a link; clients cannot use it.`);
  }
  return real;
}

/** Notes are .md / .markdown / .txt files outside dot folders. */
export function isNoteName(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}
