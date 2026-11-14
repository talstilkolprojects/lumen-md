/**
 * Small text checks for git (plan 3.3), on their own so the startup path
 * (git.ts, gitMirror.ts) does not pull in the merge engine (plan W1.9) with
 * gitMerge.ts.
 */
const decoder = new TextDecoder();

/** The first line of every Git LFS pointer file (https://git-lfs.com/spec/v1). */
export const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";


/**
 * Is this a Git LFS pointer (a small text stub that stands for the real
 * content)? The whole structure of the spec: the exact version line first,
 * then `key value` lines in key order, among them `oid sha256:<64 hex>` and
 * `size <digits>`, each ending in a newline.
 */
export function isLfsPointer(data: Uint8Array | string | null): boolean {
  if (data === null) return false;
  if (typeof data !== "string") {
    if (data.length > 1024) return false;
    data = decoder.decode(data);
  }
  if (data.length > 1024 || !data.startsWith(`${LFS_POINTER_PREFIX}\n`) || !data.endsWith("\n")) return false;
  const lines = data.slice(0, -1).split("\n").slice(1);
  let oid = false;
  let size = false;
  let last = "";
  for (const line of lines) {
    const m = /^([a-z0-9.-]+) (.+)$/.exec(line);
    if (!m || m[1] <= last) return false;
    last = m[1];
    if (m[1] === "oid") oid = /^sha256:[0-9a-f]{64}$/.test(m[2]);
    else if (m[1] === "size") size = /^\d+$/.test(m[2]);
  }
  return oid && size;
}

/** Does this text still hold an unresolved conflict: a `<<<<<<<` line, then `=======`, then `>>>>>>>`, in that order? */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?: [^\n]*)?\n(?:[^\n]*\n)*?={7}\n(?:[^\n]*\n)*?>{7}(?: [^\n]*)?$/m.test(text);
}
