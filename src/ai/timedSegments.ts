/**
 * Whisper's output on the recording's clock (plan W5.13): the worker cuts
 * long audio into windows; each window's chunk timestamps are shifted by
 * the window's start. Pure, so it is tested without the model.
 */
export interface TimedSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * One window's output → segments on the recording's clock: the model's own
 * chunk timestamps when it gives them (shifted by the window's start), else
 * the whole window as one segment.
 */
export function segmentsOf(out: { text?: string; chunks?: Array<{ timestamp?: [number, number | null]; text?: string }> }, offset: number, windowSeconds: number): TimedSegment[] {
  const chunks = (out.chunks ?? []).filter((c) => (c.text ?? "").trim());
  if (!chunks.length) return (out.text ?? "").trim() ? [{ start: offset, end: offset + windowSeconds, text: (out.text ?? "").trim() }] : [];
  return chunks.map((c, i) => {
    const s = c.timestamp?.[0] ?? 0;
    const e = c.timestamp?.[1] ?? chunks[i + 1]?.timestamp?.[0] ?? windowSeconds;
    return { start: Math.round((offset + s) * 100) / 100, end: Math.round((offset + Math.max(s, e)) * 100) / 100, text: (c.text ?? "").trim() };
  });
}
