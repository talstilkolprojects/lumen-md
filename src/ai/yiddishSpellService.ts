/**
 * Yiddish spelling service (plan W7.9): the word list download (the user's
 * own command, once; checked against its pinned SHA-256), where it is kept
 * (IndexedDB on this device), and the worker that checks. The list is
 * GPL-3.0, so it is never part of the app: the licence gate keeps it out
 * of dist, and the app only downloads it when asked.
 */
import { del, get, set } from "idb-keyval";
import "../text/jewishLanguagesStrings";
import type { GrammarMatch } from "./grammar";
import { YIDDISH_DICT, YI_SPELL_MESSAGE_KEY, yiddishDictUrl } from "./yiddishSpell";

const KEY = "lumen.dict.yi.v1";
export const YIDDISH_DICTIONARY_CHANGED_EVENT = "lumen-yiddish-dictionary-changed";

type Stored = { aff: string; dic: string; commit: string };

function announce(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(YIDDISH_DICTIONARY_CHANGED_EVENT));
  // Open editors re-check on the Hebrew dictionary's event (editor/grammarExtension.ts listens to it).
  window.dispatchEvent(new Event("lumen-hebrew-dictionary-changed"));
}

export async function yiddishDictionaryInstalled(): Promise<boolean> {
  try {
    const v = await get<Stored>(KEY);
    return !!v && typeof v.dic === "string";
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Download the two files from the pinned commit, check their hashes, keep them. Returns the word count. */
export async function downloadYiddishDictionary(fetchImpl: typeof fetch = fetch): Promise<number> {
  const texts: Record<"aff" | "dic", string> = { aff: "", dic: "" };
  for (const f of ["aff", "dic"] as const) {
    const res = await fetchImpl(yiddishDictUrl(f));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if ((await sha256Hex(text)) !== YIDDISH_DICT.files[f].sha256) throw new Error(`${YIDDISH_DICT.files[f].name}: not the pinned file (SHA-256 differs)`);
    texts[f] = text;
  }
  await set(KEY, { ...texts, commit: YIDDISH_DICT.commit } satisfies Stored);
  resetWorker();
  announce();
  return Number.parseInt(texts.dic, 10);
}

export async function removeYiddishDictionary(): Promise<void> {
  await del(KEY);
  resetWorker();
  announce();
}

let worker: Worker | null = null;
let ready: Promise<Worker | null> | null = null;
let seq = 0;
const pending = new Map<number, (m: GrammarMatch[]) => void>();

function resetWorker(): void {
  worker?.terminate();
  worker = null;
  ready = null;
  for (const resolve of pending.values()) resolve([]);
  pending.clear();
}

function startWorker(): Promise<Worker | null> {
  ready ??= (async () => {
    const stored = await get<Stored>(KEY).catch(() => undefined);
    if (!stored || typeof Worker === "undefined") return null;
    const w = new Worker(new URL("./yiddishSpell.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ type: string; id: number; matches?: GrammarMatch[] }>) => {
      pending.get(e.data.id)?.(e.data.type === "result" ? (e.data.matches ?? []) : []);
      pending.delete(e.data.id);
    };
    w.onerror = () => resetWorker();
    w.postMessage({ type: "load", aff: stored.aff, dic: stored.dic });
    worker = w;
    return w;
  })();
  return ready;
}

/** Check a Yiddish paragraph. Without the word list there is nothing to say: no matches. */
export async function checkYiddish(text: string, message: (key: string) => string = (k) => k): Promise<GrammarMatch[]> {
  const w = await startWorker();
  if (!w) return [];
  const id = ++seq;
  const matches = await new Promise<GrammarMatch[]>((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ type: "check", id, text });
  });
  return matches.map((m) => (m.message === YI_SPELL_MESSAGE_KEY ? { ...m, message: message(YI_SPELL_MESSAGE_KEY) } : m));
}
