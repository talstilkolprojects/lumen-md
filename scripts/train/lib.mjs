/**
 * The merge train's conflict logic (plan W6.42), promoted from the scripts
 * lanes T and T2 used by hand for trains 1 and 2. Pure functions on file
 * texts. scripts/train/resolve.mjs and port.mjs wrap them around git's
 * index stages. Tested in src/__tests__/trainResolve.test.ts.
 *
 * Each rule resolves by meaning, not by syntax:
 * - a JSON file gets a 3-way merge per key (`merge3`);
 * - a side whose change the other already contains is dropped (`contained`);
 * - hunks of single-line named imports merge their specifiers per module;
 * - a hunk where one side only inserted lines keeps both;
 * - a hunk where both sides only added lines becomes ours + theirs, with the
 *   shared boundary lines re-inserted where the parser needs them (`union`);
 * - anything else ports theirs' diff hunks onto ours, even when ours moved
 *   the code to another file (`portHunks`).
 * What none of them settles is left to a person (MANUAL).
 */

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 3-way merge of parsed JSON. Objects merge per key, arrays as a union in
 * order, scalars changed on both sides take theirs with a note. A key one
 * side deleted and the other changed is a problem (`deleted` in the note).
 */
export function merge3(base, ours, theirs, path = "", problems = []) {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (isObj(ours) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const inO = k in ours;
      const inT = k in theirs;
      const inB = k in b;
      if (inO && inT) out[k] = merge3(b[k], ours[k], theirs[k], `${path}.${k}`, problems);
      else if (inO) {
        if (!inB) out[k] = ours[k];
        else if (!same(b[k], ours[k])) problems.push(`${path}.${k} deleted by theirs, changed by ours`);
      } else if (!inB) out[k] = theirs[k];
      else if (!same(b[k], theirs[k])) problems.push(`${path}.${k} deleted by ours, changed by theirs`);
    }
    return out;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const seen = new Set();
    const out = [];
    for (const x of [...ours, ...theirs]) {
      const k = JSON.stringify(x);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(x);
      }
    }
    return out;
  }
  problems.push(`${path}: ${JSON.stringify(ours)} vs ${JSON.stringify(theirs)} (took theirs)`);
  return theirs;
}

/** A JSON text merged 3-way, in ours' indentation → { text, problems }. Throws on unparsable ours/theirs. */
export function mergeJsonText(baseText, oursText, theirsText) {
  const problems = [];
  let base = {};
  try {
    base = baseText ? JSON.parse(baseText) : {};
  } catch {
    base = {}; // why: a criss-cross's virtual base can hold markers; the caller may pass a real merge base instead
  }
  const m = merge3(base, JSON.parse(oursText), JSON.parse(theirsText), "", problems);
  const indent = /\n( +|\t)"/.exec(oursText)?.[1] ?? "  ";
  return { text: JSON.stringify(m, null, indent) + (oursText.endsWith("\n") ? "\n" : ""), problems };
}

const trivial = (l) => l.trim().length <= 3 || /^[\s{}()[\];,]*$/.test(l);

/**
 * Line diff (longest common subsequence on trimmed lines) → { added, removed }
 * of base → next. Small files only: the train's conflicted files are a few
 * thousand lines at most.
 */
export function lineDiff(base, next) {
  const a = base.split("\n");
  const b = next.split("\n");
  // Trim the common head and tail first: most of a file is unchanged.
  let s = 0;
  while (s < a.length && s < b.length && a[s].trim() === b[s].trim()) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1].trim() === b[eb - 1].trim()) {
    ea--;
    eb--;
  }
  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  const n = A.length;
  const m = B.length;
  if (n * m > 25_000_000) return { added: B, removed: A };
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i].trim() === B[j].trim() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const added = [];
  const removed = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i].trim() === B[j].trim()) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(A[i++]);
    else added.push(B[j++]);
  }
  while (i < n) removed.push(A[i++]);
  while (j < m) added.push(B[j++]);
  return { added, removed };
}

/**
 * Theirs' change (base → theirs) is already in ours: every non-trivial
 * added line is in ours, and every non-trivial removed line is gone from it.
 */
export function contained(base, ours, theirs) {
  const { added, removed } = lineDiff(base, theirs);
  const add = added.filter((l) => !trivial(l)).map((l) => l.trim());
  const rem = removed.filter((l) => !trivial(l)).map((l) => l.trim());
  if (!add.length && !rem.length) return true;
  const ol = new Set(ours.split("\n").map((x) => x.trim()));
  return add.every((x) => ol.has(x)) && rem.every((x) => !ol.has(x) || add.includes(x));
}

/** `git merge-file --diff3` output → segments: arrays of plain lines and { O, B, T } conflict hunks. */
export function parseDiff3(marked) {
  const lines = marked.split("\n");
  const segs = [];
  let cur = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("<<<<<<< ")) {
      segs.push(cur);
      const O = [];
      const B = [];
      const T = [];
      let tgt = O;
      i++;
      for (; i < lines.length && !lines[i].startsWith(">>>>>>> "); i++) {
        if (lines[i].startsWith("||||||| ")) tgt = B;
        else if (lines[i] === "=======") tgt = T;
        else tgt.push(lines[i]);
      }
      segs.push({ O, B, T });
      cur = [];
    } else cur.push(lines[i]);
  }
  segs.push(cur);
  return segs;
}

const IMP = /^import (type )?\{([^}]*)\} from (["'][^"']+["']);\s*$/;

/** Lines of single-line named imports → Map(module key → specifiers), or null when a line is anything else. */
export function parseImports(lines) {
  const m = new Map();
  for (const l of lines) {
    if (!l.trim()) continue;
    const x = IMP.exec(l);
    if (!x) return null;
    const key = (x[1] || "") + x[3];
    m.set(key, [...(m.get(key) || []), ...x[2].split(",").map((y) => y.trim()).filter(Boolean)]);
  }
  return m;
}

/**
 * A hunk of named imports on all three sides → the merged import lines
 * (specifiers of both sides, minus what either side removed), or null.
 */
export function mergeImportHunk({ O, B, T }) {
  const po = parseImports(O);
  const pb = parseImports(B);
  const pt = parseImports(T);
  if (!po || !pb || !pt || (!po.size && !pt.size)) return null;
  const out = [];
  for (const k of new Set([...po.keys(), ...pt.keys()])) {
    if ((!po.has(k) || !pt.has(k)) && pb.has(k)) continue; // one side removed the import
    const o = po.get(k) || [];
    const b = pb.get(k) || [];
    const t = pt.get(k) || [];
    const specs = [...new Set([...o, ...t])].filter((x) => !(b.includes(x) && (!o.includes(x) || !t.includes(x))));
    if (!specs.length) continue;
    const type = k.startsWith("type ") ? "type " : "";
    out.push(`import ${type}{ ${specs.join(", ")} } from ${type ? k.slice(5) : k};`);
  }
  return out;
}

const subseq = (small, big) => {
  let i = 0;
  for (const l of big) if (i < small.length && l.trim() === small[i].trim()) i++;
  return i === small.length;
};
const minus = (big, small) => {
  const out = [];
  let i = 0;
  for (const l of big) {
    if (i < small.length && l.trim() === small[i].trim()) {
      i++;
      continue;
    }
    out.push(l);
  }
  return out;
};

/**
 * Normalise each conflict hunk in place: imports merged, and a side that
 * only inserted lines around the base turned into a pure addition.
 * → true when every hunk is now a pure addition (or one side unchanged).
 */
export function simplifyHunks(segs) {
  const hunks = segs.filter((x) => !Array.isArray(x));
  for (const h of hunks) {
    const imp = mergeImportHunk(h);
    if (imp) {
      h.O = imp;
      h.T = imp;
      h.B = [];
    }
  }
  const unchanged = (h) => h.B.join("").trim() === "" || h.O.join("\n") === h.B.join("\n") || h.T.join("\n") === h.B.join("\n");
  for (const h of hunks) {
    if (unchanged(h)) continue;
    if (subseq(h.B, h.T)) {
      h.T = minus(h.T, h.B);
      h.B = [];
    } else if (subseq(h.B, h.O)) {
      const extra = minus(h.O, h.B);
      h.O = h.T;
      h.T = extra;
      h.B = [];
    }
  }
  return hunks.every(unchanged);
}

/**
 * The text for one choice of joints per hunk. A joint [a, b] re-inserts the
 * first `a` lines after the hunk and the last `b` lines before it between
 * ours and theirs (the braces both sides closed the same way).
 */
export function buildUnion(segs, choice = []) {
  const out = [];
  const ends = [];
  let h = 0;
  for (let k = 0; k < segs.length; k++) {
    const sg = segs[k];
    if (Array.isArray(sg)) {
      out.push(...sg);
      continue;
    }
    const [a, b] = choice[h++] || [0, 0];
    const before = Array.isArray(segs[k - 1]) ? segs[k - 1] : [];
    const after = Array.isArray(segs[k + 1]) ? segs[k + 1] : [];
    const joint = [...after.slice(0, a), ...(b ? before.slice(-b) : [])];
    const base = sg.B.join("\n");
    if (sg.O.join("\n") === sg.T.join("\n")) out.push(...sg.O);
    else if (sg.O.join("\n") === base) out.push(...sg.T);
    else if (sg.T.join("\n") === base) out.push(...sg.O);
    else out.push(...sg.O, ...joint, ...sg.T);
    ends.push(out.length);
  }
  return { text: out.join("\n"), ends };
}

/**
 * Search the joints for a union that `valid(text)` accepts (the parser, for
 * code). Up to 3 hunks: every combination, smallest joints first; more:
 * a local search that bumps the hunk before the first error.
 * `firstErrorLine(text)` returns the 0-based line of the first parse error, or -1.
 * → { text, choice } or null.
 */
export function searchUnion(segs, { valid = () => true, firstErrorLine = null, isCode = false } = {}) {
  const n = segs.filter((x) => !Array.isArray(x)).length;
  if (!n) return { text: segs.flat().join("\n"), choice: [] };
  const opts = [];
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) opts.push([a, b]);
  opts.sort((x, y) => x[0] + x[1] - (y[0] + y[1]));
  if (!isCode) {
    const u = buildUnion(segs);
    return valid(u.text) ? { text: u.text, choice: [] } : null;
  }
  if (n <= 3) {
    let tries = 0;
    let found = null;
    const rec = (i, choice) => {
      if (found || tries > 6000) return;
      if (i === n) {
        tries++;
        const u = buildUnion(segs, choice);
        if (valid(u.text)) found = { text: u.text, choice };
        return;
      }
      for (const op of opts) {
        rec(i + 1, [...choice, op]);
        if (found) return;
      }
    };
    rec(0, []);
    return found;
  }
  if (!firstErrorLine) return null;
  const pos = new Array(n).fill(0);
  for (let it = 0; it < 400; it++) {
    const choice = pos.map((i) => opts[i]);
    const u = buildUnion(segs, choice);
    const line = firstErrorLine(u.text);
    if (line < 0) return { text: u.text, choice };
    let k = 0;
    for (let j = 0; j < n; j++) if (u.ends[j] <= line + 1) k = j;
    pos[k] = (pos[k] + 1) % opts.length;
    if (pos[k] === 0 && k > 0) pos[k - 1] = (pos[k - 1] + 1) % opts.length;
  }
  return null;
}

/** A unified diff (base → theirs, -U3) → hunks { old: lines, neu: lines }. */
export function parseUnified(diff) {
  const hunks = [];
  let cur = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("@@")) {
      cur = { old: [], neu: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || l.startsWith("\\") || l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith(" ")) {
      cur.old.push(l.slice(1));
      cur.neu.push(l.slice(1));
    } else if (l.startsWith("-")) cur.old.push(l.slice(1));
    else if (l.startsWith("+")) cur.neu.push(l.slice(1));
  }
  return hunks;
}

const indentOf = (s) => s.match(/^\s*/)[0].length;

function findAll(lines, old) {
  const t = old.map((x) => x.trim());
  const hits = [];
  outer: for (let i = 0; i + t.length <= lines.length; i++) {
    for (let j = 0; j < t.length; j++) if (lines[i + j].trim() !== t[j]) continue outer;
    hits.push(i);
  }
  return hits;
}

/**
 * Apply each hunk of theirs onto ours. A hunk is located by its old lines
 * (trimmed, one unique match) in the conflicted file first, then in the
 * other candidate files (code that ours moved), and re-indented to where it
 * lands. `texts` maps file → text (the conflicted file → ours), `read(f)`
 * loads another candidate. → { texts, moved: [{ to }], left: [reasons] }.
 */
export function portHunks(file, hunks, texts, candidates = [], read = () => null) {
  const out = new Map(texts);
  const get = (f) => {
    if (!out.has(f)) {
      const t = read(f);
      if (t == null) return null;
      out.set(f, t);
    }
    return out.get(f);
  };
  const moved = [];
  const left = [];
  for (const h of hunks) {
    if (!h.old.some((x) => x.trim())) {
      left.push("a hunk with only blank context");
      continue;
    }
    let done = false;
    for (const f of [file, ...candidates.filter((c) => c !== file)]) {
      const text = get(f);
      if (text == null) continue;
      const lines = text.split("\n");
      const hits = findAll(lines, h.old);
      if (hits.length !== 1) {
        if (hits.length > 1 && f === file) {
          left.push(`a hunk matches ${hits.length}× in ours`);
          done = true;
          break;
        }
        continue;
      }
      const at = hits[0];
      const k = h.old.findIndex((x) => x.trim());
      const shift = indentOf(lines[at + k]) - indentOf(h.old[k]);
      const neu = h.neu.map((x) => (x.trim() ? (shift >= 0 ? " ".repeat(shift) + x : x.slice(Math.min(-shift, indentOf(x)))) : x));
      lines.splice(at, h.old.length, ...neu);
      out.set(f, lines.join("\n"));
      if (f !== file) moved.push({ to: f });
      done = true;
      break;
    }
    if (!done) left.push(`a hunk not found: ${h.old.filter((x) => x.trim()).slice(0, 2).join(" ⏎ ")}`);
  }
  return { texts: out, moved, left };
}

/**
 * Commit trailers that record how each train merge was resolved (the
 * ledger W6.22 and W6.42 count): clean (git merged it), auto (the
 * resolver did), manual (a person did, with the files).
 */
export const TRAILER = "Train-Resolution";
export const trailerLine = (kind, files = []) => `${TRAILER}: ${kind}${files.length ? ` (${files.join(", ")})` : ""}`;

/** The merge subject the train uses, and its parser. */
export const mergeSubject = (n, branch) => `Merge #${n} ${branch} [skip ci]`;
export function parseMerge(subject, body = "") {
  const m = /^Merge #(\d+) (\S+)/.exec(subject);
  if (!m) return null;
  const t = new RegExp(`^${TRAILER}: (clean|auto|manual)(?: \\((.*)\\))?$`, "m").exec(body);
  return { pr: Number(m[1]), branch: m[2], resolution: t ? t[1] : "unknown", files: t?.[2] ? t[2].split(", ") : [] };
}
