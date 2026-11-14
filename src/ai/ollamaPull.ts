/**
 * Ollama model downloads from the AI settings (plan 5.7).
 *
 *   pullOllamaModel(base, name, { onProgress, signal }) → resolves on "success"
 *   deleteOllamaModel(base, name)
 *
 * `/api/pull` streams NDJSON: `{status}` lines ("pulling manifest",
 * "verifying sha256 digest", "writing manifest", "success") and, per
 * layer, `{status: "pulling <digest>", digest, total, completed}`. The
 * progress reported here is the sum over every layer seen so far, so the
 * bar does not jump back to 0 % when the next layer starts. A failure
 * after the stream began comes as `{error}` under HTTP 200.
 *
 * No imports: the module also runs under plain Node (CI drives it against
 * scripts/fake-ollama.mjs with --experimental-strip-types).
 */

export interface PullProgress {
  /** Ollama's own status line ("pulling manifest", "pulling 6a0746a1ec1a", "success"). */
  status: string;
  /** Bytes done / total over all layers seen so far; total 0 while unknown. */
  completed: number;
  total: number;
  /** 0–1, or null while no layer size is known yet. */
  fraction: number | null;
}

export class OllamaPullError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OllamaPullError";
    this.status = status;
  }
}

/** Folds pull records into one running total (exported for tests). */
export function createPullTracker(): (record: Record<string, unknown>) => PullProgress {
  const layers = new Map<string, { completed: number; total: number }>();
  return (record) => {
    const digest = typeof record.digest === "string" ? record.digest : null;
    const total = typeof record.total === "number" ? record.total : null;
    if (digest && total !== null && total > 0) {
      const completed = typeof record.completed === "number" ? Math.min(record.completed, total) : 0;
      const prev = layers.get(digest);
      // Ollama may resend a layer; progress never goes backwards.
      layers.set(digest, { total, completed: Math.max(prev?.completed ?? 0, completed) });
    }
    let done = 0;
    let all = 0;
    for (const l of layers.values()) {
      done += l.completed;
      all += l.total;
    }
    const status = typeof record.status === "string" ? record.status : "";
    const fraction = status === "success" ? 1 : all > 0 ? done / all : null;
    return { status, completed: done, total: all, fraction };
  };
}

/** A name `ollama pull` accepts: [host[:port]/][namespace/]model[:tag], no spaces. */
export function validOllamaName(name: string): boolean {
  const n = name.trim();
  return /^(?:[A-Za-z0-9][A-Za-z0-9.-]*:\d{1,5}\/)?[A-Za-z0-9][A-Za-z0-9._\-/]*(:[A-Za-z0-9._\-]+)?$/.test(n) && n.length <= 200;
}

/**
 * Download `name` into the Ollama at `base`. Calls `onProgress` for every
 * record; resolves when Ollama reports "success"; rejects with
 * OllamaPullError on an HTTP error, an `{error}` record or a stream cut
 * before "success", and with AbortError when `signal` aborts.
 */
export async function pullOllamaModel(
  base: string,
  name: string,
  opts: { onProgress?: (p: PullProgress) => void; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const model = name.trim();
  if (!validOllamaName(model)) throw new OllamaPullError(`Not a model name: "${model}"`);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${base.replace(/\/+$/, "")}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OllamaPullError(`Ollama API error ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`, res.status);
  }
  const track = createPullTracker();
  let success = false;
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof record.error === "string") throw new OllamaPullError(`Ollama: ${record.error}`);
    const p = track(record);
    if (p.status === "success") success = true;
    opts.onProgress?.(p);
  };
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (some fetch polyfills): the whole NDJSON at once.
    for (const line of (await res.text()).split("\n")) consume(line);
  } else {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    consume(buffer + decoder.decode());
  }
  if (!success) throw new OllamaPullError("Ollama: the download ended before it finished");
}

/** Remove an installed model (`DELETE /api/delete`). */
export async function deleteOllamaModel(base: string, name: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${base.replace(/\/+$/, "")}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name.trim() }),
  });
  if (!res.ok) throw new OllamaPullError(`Ollama API error ${res.status}`, res.status);
}
