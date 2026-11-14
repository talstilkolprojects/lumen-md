/**
 * Cancel any AI request (T55). Every AI command starts an operation here
 * and passes its signal down (agent runtime, chat, research); Esc — or the
 * "Cancel AI" command — aborts everything that is running.
 */

const live = new Set<AbortController>();
const listeners = new Set<(busy: boolean) => void>();

function emit(): void {
  for (const fn of [...listeners]) fn(live.size > 0);
}

export interface AiOperation {
  signal: AbortSignal;
  end(): void;
}

/** Start an AI operation; call end() when it finishes (finally). */
export function aiOperation(): AiOperation {
  const c = new AbortController();
  live.add(c);
  emit();
  return {
    signal: c.signal,
    end() {
      if (live.delete(c)) emit();
    },
  };
}

/** Abort every running AI operation. Returns how many were cancelled. */
export function cancelAllAi(): number {
  const n = live.size;
  for (const c of live) c.abort(new DOMException("Cancelled by the user", "AbortError"));
  live.clear();
  if (n) emit();
  return n;
}

export function aiBusy(): boolean {
  return live.size > 0;
}

export function onAiBusy(fn: (busy: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Was this error an abort (ours or the platform's)? */
export function isAbort(e: unknown): boolean {
  const err = e as { name?: string; run?: { status?: string } } | null;
  return !!err && (err.name === "AbortError" || err.run?.status === "aborted");
}

let installed = false;
/** Esc cancels running AI work (dialogs keep their own Esc handling too). */
export function installAiEscape(onCancelled: (n: number) => void): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // Capture phase: a menu or dialog that stops Esc's propagation must not
  // keep the AI work running.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !live.size) return;
      const n = cancelAllAi();
      if (n) onCancelled(n);
    },
    { capture: true },
  );
}

/** Run `fn` as an AI operation; an abort resolves to `undefined` quietly. */
export async function withAiOperation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const op = aiOperation();
  try {
    return await fn(op.signal);
  } catch (e) {
    if (isAbort(e)) return undefined;
    throw e;
  } finally {
    op.end();
  }
}

/** Tests. */
export function __resetAiAbort(): void {
  live.clear();
  listeners.clear();
  installed = false;
}
