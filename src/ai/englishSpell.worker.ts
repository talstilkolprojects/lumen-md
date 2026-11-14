/// <reference lib="webworker" />
/**
 * English spelling worker (plan 6.10): builds nspell from the en-US
 * Hunspell files (fetched same-origin from the app's own dict/, precached
 * for offline; ≈ 0.35 s to build, once) off the main thread and answers
 * check requests. Nothing is sent anywhere.
 */
import nspell from "nspell";
import { loadEnglishDictionary } from "./englishDictionary";
import { englishSpelling } from "./englishSpell";
import type { GrammarMatch } from "./grammar";

type In = { type: "check"; id: number; text: string; personal?: string[] };
type Out = { type: "result"; id: number; matches: GrammarMatch[] } | { type: "failed"; id: number };

let spell: Promise<ReturnType<typeof nspell>> | null = null;
const suggestCache = new Map<string, string[]>();

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data;
  if (msg.type !== "check") return;
  spell ??= loadEnglishDictionary().then(({ aff, dic }) => nspell(aff, dic));
  let checker: ReturnType<typeof nspell>;
  try {
    checker = await spell;
  } catch {
    // The dictionary did not load (offline before it was ever cached): the
    // service retires this worker and answers on the main thread.
    (self as unknown as Worker).postMessage({ type: "failed", id: msg.id } satisfies Out);
    return;
  }
  const personal = new Set((msg.personal ?? []).map((w) => w.toLowerCase()));
  if (suggestCache.size > 2000) suggestCache.clear();
  const matches = englishSpelling(checker, msg.text, { personal, suggestCache });
  (self as unknown as Worker).postMessage({ type: "result", id: msg.id, matches } satisfies Out);
};
