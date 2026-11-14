/**
 * The Hebrew lexicon pack on this device (plan W5.26). Downloaded only when
 * the person asks (the palette's "Hebrew dictionary and synonyms" command),
 * from this app's own origin, checked against public/lexicon/manifest.json
 * (size and sha256), and kept in Cache Storage so it works offline. Nothing
 * is fetched at startup, and nothing is sent anywhere: lookups are local.
 *
 * The pack is built by scripts/build-hebrew-lexicon.mjs from a Hebrew
 * Wiktionary dump (CC BY-SA 4.0). Until it has been built and published,
 * the manifest is missing and the command says so.
 */
import { buildIndex, isPack, type LexiconIndex } from "./lexicon";
import { LEXICON_FLAG } from "./installed";

export const LEXICON_PACK_PATH = "lexicon/he-wiktionary.json";
export const LEXICON_MANIFEST_PATH = "lexicon/manifest.json";
export const LEXICON_CACHE = "lumen-lexicon";

export interface LexiconManifest {
  file: string;
  bytes: number;
  sha256: string;
  count: number;
  words: number;
  source: string;
  license: string;
}

export class LexiconUnavailableError extends Error {
  constructor() {
    super("lexicon pack not published");
    this.name = "LexiconUnavailableError";
  }
}

export interface StoreDeps {
  fetch?: typeof fetch;
  caches?: CacheStorage;
  base?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

function baseUrl(): string {
  // One name at a time (src/lib/publicEnv.ts): a whole import.meta.env inlines every VITE_* name.
  return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
}

const urlOf = (path: string, deps: StoreDeps) => new URL(`${deps.base ?? baseUrl()}${path}`, typeof location !== "undefined" ? location.href : "https://example.com/").href;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The published manifest, or null when the pack has not been built yet. */
export async function lexiconManifest(deps: StoreDeps = {}): Promise<LexiconManifest | null> {
  const res = await (deps.fetch ?? fetch)(urlOf(LEXICON_MANIFEST_PATH, deps), { cache: "no-cache" });
  if (!res.ok) return null;
  const m = (await res.json().catch(() => null)) as LexiconManifest | null;
  return m && typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) && Number.isInteger(m.bytes) ? m : null;
}

/** Download and keep the pack (asking is the caller's job). Returns the number of entries. */
export async function downloadLexicon(deps: StoreDeps = {}): Promise<number> {
  const manifest = await lexiconManifest(deps);
  if (!manifest) throw new LexiconUnavailableError();
  const url = urlOf(LEXICON_PACK_PATH, deps);
  const res = await (deps.fetch ?? fetch)(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength !== manifest.bytes) throw new Error(`size ${bytes.byteLength}, expected ${manifest.bytes}`);
  if ((await sha256Hex(bytes)) !== manifest.sha256) throw new Error("checksum mismatch");
  const pack = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!isPack(pack)) throw new Error("not a lexicon pack");
  const cache = await (deps.caches ?? caches).open(LEXICON_CACHE);
  await cache.put(url, new Response(bytes, { headers: { "content-type": "application/json" } }));
  (deps.storage ?? localStorage).setItem(LEXICON_FLAG, "1");
  index = null;
  return pack.count;
}

export async function removeLexicon(deps: StoreDeps = {}): Promise<void> {
  await (deps.caches ?? caches).delete(LEXICON_CACHE);
  (deps.storage ?? localStorage).removeItem(LEXICON_FLAG);
  index = null;
}

let index: Promise<LexiconIndex> | null = null;

/** The index of the stored pack (built once per session). Throws when it is not installed. */
export function loadLexicon(deps: StoreDeps = {}): Promise<LexiconIndex> {
  if (!index) {
    index = (async () => {
      const cache = await (deps.caches ?? caches).open(LEXICON_CACHE);
      const hit = await cache.match(urlOf(LEXICON_PACK_PATH, deps));
      if (!hit) {
        (deps.storage ?? localStorage).removeItem(LEXICON_FLAG);
        throw new Error("lexicon not installed");
      }
      const pack = (await hit.json()) as unknown;
      if (!isPack(pack)) throw new Error("not a lexicon pack");
      return buildIndex(pack);
    })();
    index.catch(() => {
      index = null;
    });
  }
  return index;
}

/** Tests. */
export function __resetLexicon(): void {
  index = null;
}
