/**
 * Safe git pull, the pure part (plan 3.3): decide, per file, what a pull
 * does to the vault. No I/O here — `git.ts` gathers the three versions of
 * every file the remote changed and `gitPull.ts` carries out the plan.
 *
 * For each path the remote changed since the merge base we have:
 *   base   — the file at the merge base (null: not there),
 *   ours   — the file in the vault now (null: not there),
 *   theirs — the file at the fetched commit (null: deleted upstream).
 *
 * The rules, in order (nothing in the vault is ever deleted):
 *   - deleted upstream                → kept here, reported;
 *   - an LFS pointer over a real file → the local file is kept, reported
 *                                        (Git LFS is not supported);
 *   - ours equals theirs              → nothing to do;
 *   - not here (new upstream, or deleted here and changed upstream)
 *                                      → written (nothing local to lose);
 *   - unchanged here (ours = base)    → theirs is written;
 *   - changed on both sides           → a line-based three-way merge
 *     (diff3: stable lines both sides kept, unstable chunks between them):
 *     clean → the merged text; a chunk both sides changed differently —
 *     including one side deleting what the other edited — is a conflict,
 *     with the usual `<<<<<<<` / `=======` / `>>>>>>>` markers, for the
 *     resolution screen; binary files are never merged: ours stays, theirs
 *     goes to a copy.
 */
import type { DiffHunk } from "./cloud/diff";

export type Bytes = Uint8Array;

export interface PullEntry {
  /** Path inside the repository (forward slashes, no leading slash). */
  path: string;
  base: Bytes | null;
  ours: Bytes | null;
  theirs: Bytes | null;
}

export type PullAction =
  /** Write `data` to the file (`lfs`: it is an LFS pointer, written because nothing was here). */
  | { kind: "write"; path: string; data: Bytes; why: "upstream" | "merged" | "restored"; lfs?: boolean }
  /** Both sides changed the same lines. `marked` holds both versions between conflict markers. */
  | { kind: "conflict"; path: string; base: string; ours: string; theirs: string; marked: string }
  /** Both sides changed a binary file: ours stays, theirs is kept as a copy next to it. */
  | { kind: "binaryConflict"; path: string; theirs: Bytes }
  /** Deleted upstream, still here: kept (a pull never deletes). */
  | { kind: "keptDeletedUpstream"; path: string }
  /** Upstream holds a Git LFS pointer where this vault has the real file: the file is kept. */
  | { kind: "lfsSkipped"; path: string };

/** The first line of every Git LFS pointer file (https://git-lfs.com/spec/v1). */
export const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Is this a Git LFS pointer (a small text stub that stands for the real
 * content)? The whole structure of the spec: the exact version line first,
 * then `key value` lines in key order, among them `oid sha256:<64 hex>` and
 * `size <digits>`, each ending in a newline.
 */
export function isLfsPointer(data: Bytes | string | null): boolean {
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

/** Binary, for merging: a NUL byte near the start, or not valid UTF-8 (git's own heuristic, plus the UTF-8 check). */
export function isBinary(data: Bytes): boolean {
  const head = data.subarray(0, 8000);
  if (head.includes(0)) return true;
  try {
    strictDecoder.decode(data);
    return false;
  } catch {
    return true;
  }
}

export function sameBytes(a: Bytes | null, b: Bytes | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface MergeLabels {
  ours: string;
  theirs: string;
}

/** Does this text still hold an unresolved conflict: a `<<<<<<<` line, then `=======`, then `>>>>>>>`, in that order? */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?: [^\n]*)?\n(?:[^\n]*\n)*?={7}\n(?:[^\n]*\n)*?>{7}(?: [^\n]*)?$/m.test(text);
}

/** Pairs [i, j] of equal lines in a longest common subsequence of a and b. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> | null {
  // Common head and tail first: most merges touch a few lines of a long note.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n * m > 25_000_000) return null; // too big to align here: the caller treats it as one conflict
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[head + i] === b[head + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      pairs.push([head + i, head + j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

/**
 * Line-based three-way merge (diff3), as hunks the conflict dialog shows.
 * Lines kept by both sides anchor the merge; between anchors, a chunk
 * changed on one side only takes that side ("local" / "remote"), the same
 * change on both sides is taken once ("both"), and anything else —
 * different edits, or a deletion against an edit — is a "conflict".
 */
export function mergeHunks(base: string, ours: string, theirs: string): DiffHunk[] {
  const B = base.split("\n");
  const O = ours.split("\n");
  const T = theirs.split("\n");
  const po = lcsPairs(B, O);
  const pt = lcsPairs(B, T);
  if (!po || !pt) return [{ op: "conflict", local: O, remote: T, base: B }];
  const inO = new Map(po);
  const inT = new Map(pt);
  const out: DiffHunk[] = [];
  const push = (h: DiffHunk) => {
    const prev = out[out.length - 1];
    if (prev && prev.op === h.op && h.op !== "conflict") {
      prev.local.push(...h.local);
      prev.remote.push(...h.remote);
      prev.base.push(...h.base);
    } else out.push(h);
  };
  let b0 = 0;
  let o0 = 0;
  let t0 = 0;
  const chunk = (b1: number, o1: number, t1: number) => {
    const cb = B.slice(b0, b1);
    const co = O.slice(o0, o1);
    const ct = T.slice(t0, t1);
    if (!cb.length && !co.length && !ct.length) return;
    const op = same(co, cb) ? (same(ct, cb) ? "equal" : "remote") : same(ct, cb) ? "local" : same(co, ct) ? "both" : "conflict";
    push({ op, local: co, remote: ct, base: cb });
  };
  for (let i = 0; i < B.length; i++) {
    const oi = inO.get(i);
    const ti = inT.get(i);
    if (oi === undefined || ti === undefined) continue;
    // A stable line: kept by both sides.
    chunk(i, oi, ti);
    push({ op: "equal", local: [B[i]], remote: [B[i]], base: [B[i]] });
    b0 = i + 1;
    o0 = oi + 1;
    t0 = ti + 1;
  }
  chunk(B.length, O.length, T.length);
  return out;
}

/** Line-based three-way merge (see `mergeHunks`); conflicts are written between markers. */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  labels: MergeLabels = { ours: "local", theirs: "remote" },
): { clean: boolean; text: string } {
  if (ours === theirs) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  if (theirs === base) return { clean: true, text: ours };
  const out: string[] = [];
  let clean = true;
  for (const h of mergeHunks(base, ours, theirs)) {
    if (h.op === "remote") out.push(...h.remote);
    else if (h.op !== "conflict") out.push(...h.local);
    else {
      clean = false;
      out.push(`<<<<<<< ${labels.ours}`, ...h.local, "=======", ...h.remote, `>>>>>>> ${labels.theirs}`);
    }
  }
  return { clean, text: out.join("\n") };
}

/** Plan a pull. Paths whose upstream version equals the base are not passed in (or produce nothing). */
export function planPull(entries: PullEntry[], labels?: MergeLabels): PullAction[] {
  const actions: PullAction[] = [];
  for (const { path, base, ours, theirs } of entries) {
    if (sameBytes(base, theirs)) continue; // upstream did not change it
    if (theirs === null) {
      if (ours !== null) actions.push({ kind: "keptDeletedUpstream", path });
      continue;
    }
    const lfs = isLfsPointer(theirs);
    if (lfs && ours !== null && !isLfsPointer(ours)) {
      actions.push({ kind: "lfsSkipped", path });
      continue;
    }
    if (sameBytes(ours, theirs)) continue;
    if (ours === null) {
      actions.push({ kind: "write", path, data: theirs, why: base === null ? "upstream" : "restored", ...(lfs ? { lfs } : {}) });
      continue;
    }
    if (sameBytes(ours, base)) {
      actions.push({ kind: "write", path, data: theirs, why: "upstream", ...(lfs ? { lfs } : {}) });
      continue;
    }
    // Changed on both sides (or added on both sides with different content).
    if (isBinary(ours) || isBinary(theirs) || (base !== null && isBinary(base))) {
      actions.push({ kind: "binaryConflict", path, theirs });
      continue;
    }
    const b = base === null ? "" : decoder.decode(base);
    const o = decoder.decode(ours);
    const t = decoder.decode(theirs);
    const merged = mergeText(b, o, t, labels);
    if (merged.clean) {
      if (merged.text !== o) actions.push({ kind: "write", path, data: encoder.encode(merged.text), why: "merged" });
    } else {
      actions.push({ kind: "conflict", path, base: b, ours: o, theirs: t, marked: merged.text });
    }
  }
  return actions;
}

/** `notes/a.md` → `notes/a (from git 1a2b3c4).md`: where a version that could not be merged is kept. */
export function copyPathFor(path: string, label: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${stem} (${label})${ext}`;
}
