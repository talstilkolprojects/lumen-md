/// <reference lib="webworker" />
/**
 * Hebrew spelling worker (T28, plan 9.2): holds the word lists off the main
 * thread and answers check requests.
 *
 * - The bundled frequency list (FrequencyWords he_50k, CC BY-SA 4.0) is
 *   fetched from the app itself — precached, so offline from install —
 *   the first time a check needs it: spelling *hints* and two grammar rules.
 * - Hspell's 340k-word list, when the user downloaded it (AGPL-3.0, never
 *   bundled), does the spelling instead.
 */
import { buildDictionary, hebrewRules, hebrewSpelling } from "./hebrewSpell";
import { offlineHebrewChecks, parseFrequencyList, type FrequencyList } from "./hebrewFreq";
import type { GrammarMatch } from "./grammar";

let dict: Set<string> | null = null;
let freq: FrequencyList | null = null;
let freqLoad: Promise<void> | null = null;

type In = { type: "load"; dic: string } | { type: "freq"; url: string } | { type: "check"; id: number; text: string };
type Out = { type: "loaded"; words: number } | { type: "freq-loaded"; words: number } | { type: "result"; id: number; matches: GrammarMatch[] };

self.onmessage = (e: MessageEvent<In>) => {
  const msg = e.data;
  if (msg.type === "load") {
    dict = buildDictionary(msg.dic);
    (self as unknown as Worker).postMessage({ type: "loaded", words: dict.size } satisfies Out);
  } else if (msg.type === "freq") {
    // A missing list (an old cache, a failed fetch) only costs the hints: the
    // rules still run. No check waits for it: checks made before it arrives
    // go out without hints, and "freq-loaded" asks the page to check again.
    freqLoad ??= fetch(msg.url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => {
        freq = parseFrequencyList(text);
        (self as unknown as Worker).postMessage({ type: "freq-loaded", words: freq.counts.size } satisfies Out);
      })
      .catch(() => undefined);
  } else if (msg.type === "check") {
    const d = dict;
    const matches = offlineHebrewChecks(freq, msg.text, hebrewRules, d ? (t) => hebrewSpelling(d, t) : undefined);
    (self as unknown as Worker).postMessage({ type: "result", id: msg.id, matches } satisfies Out);
  }
};
