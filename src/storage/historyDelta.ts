/**
 * Version deltas for the history store (plan 3.2), loaded on demand by
 * ./history — not part of the startup bundle.
 *
 * A delta turns one version's text into the next: a list of ops, where a
 * positive number keeps that many characters, a negative one deletes that
 * many and a string inserts it. The changed middle (after the common
 * prefix and suffix) is diffed line by line with Myers' O(ND) algorithm,
 * so several separate edits cost only their own lines. The ops are then
 * JSON-encoded and deflated (CompressionStream, where the engine has it).
 */

export type DeltaOp = number | string;
/** What is stored: deflated JSON bytes, or the JSON itself without CompressionStream. */
export type DeltaPayload = Uint8Array | string;

/** Myers edit distance limit on lines; beyond it the middle is replaced whole. */
const MAX_EDIT_LINES = 500;

function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Line-level Myers diff of `a` → `b`; null when the edit is too big to search. */
function myers(a: string[], b: string[]): Array<["=" | "-" | "+", string]> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_LINES);
  const v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        // Walk the trace back to the start.
        const out: Array<["=" | "-" | "+", string]> = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const ck = cx - cy;
          const prevK = ck === -dd || (ck !== dd && (pv.get(ck - 1) ?? -1) < (pv.get(ck + 1) ?? -1)) ? ck + 1 : ck - 1;
          const px = pv.get(prevK) ?? 0;
          const py = px - prevK;
          while (cx > px && cy > py) out.push(["=", a[--cx]]), cy--;
          if (cx === px) out.push(["+", b[--cy]]);
          else out.push(["-", a[--cx]]);
        }
        while (cx > 0 && cy > 0) out.push(["=", a[--cx]]), cy--;
        return out.reverse();
      }
    }
  }
  return null;
}

/** Ops that turn `a` into `b`. */
export function diff(a: string, b: string): DeltaOp[] {
  if (a === b) return a.length ? [a.length] : [];
  let pre = 0;
  const lim = Math.min(a.length, b.length);
  while (pre < lim && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  // Back up to a line start so the middle is whole lines.
  while (pre > 0 && a[pre - 1] !== "\n") pre--;
  let suf = 0;
  while (suf < lim - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: DeltaOp[] = [];
  const push = (op: DeltaOp) => {
    const last = ops[ops.length - 1];
    if (typeof op === "number" && typeof last === "number" && Math.sign(op) === Math.sign(last)) ops[ops.length - 1] = last + op;
    else if (typeof op === "string" && typeof last === "string") ops[ops.length - 1] = last + op;
    else if (op !== 0 && op !== "") ops.push(op);
  };
  if (pre) push(pre);
  const lines = myers(splitLines(am), splitLines(bm));
  if (lines) {
    for (const [kind, line] of lines) push(kind === "=" ? line.length : kind === "-" ? -line.length : line);
  } else {
    push(-am.length);
    push(bm);
  }
  if (suf) push(suf);
  return ops;
}

export function applyDelta(base: string, ops: DeltaOp[]): string {
  let out = "";
  let i = 0;
  for (const op of ops) {
    if (typeof op === "string") out += op;
    else if (op > 0) {
      out += base.slice(i, i + op);
      i += op;
    } else i -= op;
  }
  return out;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(data as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

const canCompress = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function" && typeof Response === "function";

export async function encodeDelta(ops: DeltaOp[]): Promise<DeltaPayload> {
  const json = JSON.stringify(ops);
  if (!canCompress()) return json;
  try {
    return await pipe(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
  } catch {
    return json;
  }
}

export async function decodeDelta(payload: DeltaPayload): Promise<DeltaOp[]> {
  if (typeof payload === "string") return JSON.parse(payload) as DeltaOp[];
  const bytes = await pipe(payload, new DecompressionStream("deflate-raw"));
  return JSON.parse(new TextDecoder().decode(bytes)) as DeltaOp[];
}

/** Stored size of a payload, in bytes. */
export function payloadBytes(p: DeltaPayload | undefined): number {
  if (p === undefined) return 0;
  return typeof p === "string" ? new TextEncoder().encode(p).length : p.byteLength;
}
