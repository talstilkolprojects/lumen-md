/**
 * The agent runtime's input splitting and output merging (plan W6.25: moved
 * out of runtime.ts unchanged; runtime.ts re-exports both).
 */

/**
 * Parts of at most `max` characters, cut at blank lines, then at line ends,
 * then at sentence ends — never inside a fenced code block when a cut
 * elsewhere fits.
 */
export function splitText(text: string, max: number): string[] {
  const blocks: string[] = [];
  let fence = false;
  let cur = "";
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    cur += (cur ? "\n" : "") + line;
    if (!fence && line.trim() === "") {
      blocks.push(cur);
      cur = "";
    }
  }
  if (cur) blocks.push(cur);
  const parts: string[] = [];
  let acc = "";
  const push = (piece: string) => {
    if (acc && acc.length + 1 + piece.length > max) {
      parts.push(acc);
      acc = "";
    }
    if (piece.length <= max) acc = acc ? `${acc}\n${piece}` : piece;
    else {
      // One block longer than a part: cut it at sentence ends, else hard.
      const sentences = piece.match(/[^.!?。\n]+[.!?。]*\s*|\n/g) ?? [piece];
      for (const sentence of sentences) {
        if (acc.length + sentence.length > max && acc) {
          parts.push(acc);
          acc = "";
        }
        if (sentence.length <= max) acc += sentence;
        else {
          // A sentence longer than a part: hard cuts, each a part of its own.
          if (acc) parts.push(acc);
          for (let i = 0; i < sentence.length; i += max) parts.push(sentence.slice(i, i + max));
          acc = "";
        }
      }
    }
  };
  for (const b of blocks) push(b.replace(/\n+$/, ""));
  if (acc) parts.push(acc);
  return parts.filter((p) => p.trim());
}

/** Merge the answers of the parts: text joined by a blank line; JSON objects with their lists concatenated (first value wins otherwise). */
export function mergeOutputs<O>(outputs: O[]): O {
  if (outputs.length <= 1) return outputs[0];
  if (outputs.every((o) => typeof o === "string")) return (outputs as unknown as string[]).map((o) => o.trim()).join("\n\n") as unknown as O;
  if (outputs.every((o) => o && typeof o === "object" && !Array.isArray(o))) {
    const merged: Record<string, unknown> = {};
    for (const o of outputs as unknown as Record<string, unknown>[]) {
      for (const [k, v] of Object.entries(o)) {
        if (Array.isArray(v)) {
          const prev = Array.isArray(merged[k]) ? (merged[k] as unknown[]) : [];
          // Lists of plain values (tags) without repeats.
          merged[k] = v.every((x) => typeof x !== "object") ? [...new Set([...prev, ...v])] : [...prev, ...v];
        } else if (!(k in merged)) merged[k] = v;
      }
    }
    return merged as O;
  }
  if (outputs.every(Array.isArray)) return (outputs as unknown as unknown[][]).flat() as unknown as O;
  return outputs[0];
}

