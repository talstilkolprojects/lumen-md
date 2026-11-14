/**
 * Chrome's built-in model through the Prompt API (plan W7.14):
 * `LanguageModel`, on the page from Chrome 148 desktop (Windows, macOS,
 * Linux, Chromebook Plus), with `responseConstraint` (a JSON Schema) for
 * structured output — https://developer.chrome.com/docs/ai/prompt-api.
 *
 * Detected at run time: no `LanguageModel`, a mobile browser, or an
 * availability other than "available" means this engine is not there and
 * the caller moves on to the next one. It never starts the model download
 * itself (that needs a user gesture and the network): it is the
 * "zero download" tier only once Chrome already has the model.
 */

export type BuiltinAvailability = "available" | "downloadable" | "downloading" | "unavailable";

interface LanguageModelSession {
  prompt(input: string, opts?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}

export interface LanguageModelApi {
  availability(opts?: { expectedInputs?: Array<{ type: string; languages?: string[] }>; expectedOutputs?: Array<{ type: string; languages?: string[] }> }): Promise<BuiltinAvailability>;
  create(opts?: { initialPrompts?: Array<{ role: "system" | "user" | "assistant"; content: string }>; temperature?: number; topK?: number; expectedInputs?: unknown; expectedOutputs?: unknown }): Promise<LanguageModelSession>;
}

/** The page's `LanguageModel`, or null. Tests pass their own. */
export function languageModelApi(g: unknown = globalThis): LanguageModelApi | null {
  const lm = (g as { LanguageModel?: unknown }).LanguageModel as Partial<LanguageModelApi> | undefined;
  return lm && typeof lm.availability === "function" && typeof lm.create === "function" ? (lm as LanguageModelApi) : null;
}

/** Desktop only (the API is not on Chrome for Android or iOS). */
export function isMobileBrowser(nav: { userAgent?: string; userAgentData?: { mobile?: boolean } } | undefined = typeof navigator === "undefined" ? undefined : (navigator as never)): boolean {
  if (!nav) return false;
  if (nav.userAgentData?.mobile) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? "");
}

/** "available" only when the model is already on the device and this is a desktop browser. */
export async function builtinAvailability(api: LanguageModelApi | null = languageModelApi(), nav?: Parameters<typeof isMobileBrowser>[0]): Promise<BuiltinAvailability> {
  if (!api || isMobileBrowser(nav)) return "unavailable";
  try {
    return await api.availability({ expectedInputs: [{ type: "text" }], expectedOutputs: [{ type: "text", languages: ["en"] }] });
  } catch {
    return "unavailable";
  }
}

/** One structured prompt: a fresh session per call (no state between calls). */
export async function promptBuiltin(api: LanguageModelApi, req: { system?: string; prompt: string; schema: unknown; temperature?: number; signal?: AbortSignal }): Promise<string> {
  const session = await api.create({
    ...(req.system ? { initialPrompts: [{ role: "system" as const, content: req.system }] } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature, topK: 1 } : {}),
  });
  try {
    return await session.prompt(req.prompt, { responseConstraint: req.schema, ...(req.signal ? { signal: req.signal } : {}) });
  } finally {
    session.destroy?.();
  }
}
