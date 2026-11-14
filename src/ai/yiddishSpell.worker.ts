/// <reference lib="webworker" />
/**
 * Yiddish spelling worker (plan W7.9): builds nspell from the word list the
 * user downloaded (handed over by the service, ≈ 1.4 s once) and answers
 * check requests off the main thread. It fetches nothing.
 */
import nspell from "nspell";
import { yiddishSpelling } from "./yiddishSpell";
import type { GrammarMatch } from "./grammar";

type In = { type: "load"; aff: string; dic: string } | { type: "check"; id: number; text: string };
type Out = { type: "result"; id: number; matches: GrammarMatch[] } | { type: "failed"; id: number };

let spell: ReturnType<typeof nspell> | null = null;
const suggestCache = new Map<string, string[]>();

self.onmessage = (e: MessageEvent<In>) => {
  const msg = e.data;
  if (msg.type === "load") {
    spell = nspell(msg.aff, msg.dic);
    suggestCache.clear();
    return;
  }
  if (!spell) {
    (self as unknown as Worker).postMessage({ type: "failed", id: msg.id } satisfies Out);
    return;
  }
  if (suggestCache.size > 2000) suggestCache.clear();
  (self as unknown as Worker).postMessage({ type: "result", id: msg.id, matches: yiddishSpelling(spell, msg.text, { suggestCache }) } satisfies Out);
};
