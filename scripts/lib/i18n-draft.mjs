/**
 * Translation drafts for new keys (plan 9.6).
 *
 * `npm run i18n:draft` finds the English keys a language doesn't have yet,
 * drafts them in every language with a local engine (Ollama today; the
 * on-device MT of plan 6.4 plugs in as another engine), writes the drafts
 * into the domain files, and lists each one as **needs review** in
 * `i18n/needs-review/<domain>.json`:
 *
 *   { "<key>": { "<lang>": "<hash of the English text drafted from>" } }
 *
 * The UI shows a draft right away, but the values gate
 * (src/__tests__/i18nValues.test.ts) counts it as untranslated until a
 * person approves it (`npm run i18n:draft -- --approve=<lang> [--keys=…]`).
 * The hash says which English text a draft was made from, so a reviewer
 * can tell a draft that went stale. Files are per domain and sorted
 * (plan 0.3), so two branches don't conflict.
 *
 * Pure: the engine and the file access are passed in, so the tests run it
 * on a temporary tree with a fake engine.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, domainOf, formatJson, placeholders, sortedObject } from "./i18n-files.mjs";

export const REVIEW_DIR = join(ROOT, "i18n", "needs-review");
export const DRAFT_LOCALES = ["ar", "de", "fr", "he", "ja", "ru", "zh-CN"];

/** FNV-1a of the English text: a draft goes stale when its source changes. */
export function sourceHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** { key: { lang: hash } } from every review file. */
export function readNeedsReview(dir = REVIEW_DIR) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    Object.assign(out, JSON.parse(readFileSync(join(dir, name), "utf8")));
  }
  return out;
}

/** Writes the review list as one sorted file per domain (none when empty). */
export function writeNeedsReview(review, dir = REVIEW_DIR) {
  const parts = {};
  for (const [key, langs] of Object.entries(review)) {
    if (!langs || !Object.keys(langs).length) continue;
    (parts[domainOf(key)] ??= {})[key] = sortedObject(langs);
  }
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".json") && !(name.slice(0, -5) in parts)) rmSync(join(dir, name));
  }
  for (const [d, part] of Object.entries(parts)) {
    const sorted = {};
    for (const k of Object.keys(part).sort()) sorted[k] = part[k];
    writeFileSync(join(dir, `${d}.json`), formatJson(sorted));
  }
}

/** The keys of `lang` still waiting for review. */
export function unreviewed(lang, en, review) {
  return Object.keys(review).filter((k) => review[k]?.[lang] !== undefined && k in en);
}

/**
 * `{name}` placeholders and `inline code` swapped for numbered tokens the
 * engine leaves alone, and the way back. A draft that loses or invents a
 * token is rejected rather than written.
 */
export function protect(text) {
  const kept = [];
  const masked = text.replace(/\{\{?\w+\}?\}|`[^`]*`/g, (m) => {
    kept.push(m);
    return `⟦${kept.length - 1}⟧`;
  });
  const restore = (out) => {
    const found = [...out.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1]));
    if (found.length !== kept.length || new Set(found).size !== kept.length || found.some((n) => n >= kept.length)) return null;
    return out.replace(/⟦(\d+)⟧/g, (_, n) => kept[Number(n)]);
  };
  return { masked, restore };
}

/** A draft that keeps exactly the source's placeholders, else null. */
export function acceptDraft(source, draft) {
  if (typeof draft !== "string" || !draft.trim()) return null;
  const want = placeholders(source).sort().join(",");
  return placeholders(draft).sort().join(",") === want ? draft : null;
}

/**
 * Drafts the missing keys.
 *
 *   en       the English strings
 *   locales  { lang: strings } for every target language
 *   engine   { id, translate(texts: string[], lang) → Promise<string[]> }
 *   keys     only these keys (default: every English key a language lacks)
 *   review   the current needs-review list (updated in place and returned)
 *
 * Returns { drafts: { lang: { key: text } }, rejected: [{ lang, key, reason }], review }.
 */
export async function draftMissing({ en, locales, engine, keys, review = {} }) {
  const drafts = {};
  const rejected = [];
  const wanted = keys ? keys.filter((k) => k in en) : Object.keys(en);
  for (const lang of Object.keys(locales).sort()) {
    const have = locales[lang];
    const todo = wanted.filter((k) => !(k in have));
    if (!todo.length) continue;
    const masks = todo.map((k) => protect(en[k]));
    let out;
    try {
      out = await engine.translate(masks.map((m) => m.masked), lang);
    } catch (e) {
      for (const key of todo) rejected.push({ lang, key, reason: `engine: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    todo.forEach((key, i) => {
      const restored = typeof out?.[i] === "string" ? masks[i].restore(out[i]) : null;
      const text = restored === null ? null : acceptDraft(en[key], restored);
      if (text === null) {
        rejected.push({ lang, key, reason: "placeholders or code changed" });
        return;
      }
      (drafts[lang] ??= {})[key] = text;
      (review[key] ??= {})[lang] = sourceHash(en[key]);
    });
  }
  return { drafts, rejected, review };
}

/** Marks drafts as reviewed: every key of `lang`, or only `keys`. Returns how many. */
export function approve(review, lang, keys) {
  let n = 0;
  for (const key of keys ?? Object.keys(review)) {
    if (review[key]?.[lang] === undefined) continue;
    delete review[key][lang];
    if (!Object.keys(review[key]).length) delete review[key];
    n++;
  }
  return n;
}

// ── Engines ─────────────────────────────────────────────────────────────

const LANGUAGE_NAMES = { ar: "Arabic", de: "German", fr: "French", he: "Hebrew", ja: "Japanese", ru: "Russian", "zh-CN": "Simplified Chinese" };

/**
 * Ollama on this machine (`OLLAMA_HOST`, default http://127.0.0.1:11434).
 * One request per language: a JSON array in, a JSON array out.
 */
export function ollamaEngine({ host = "http://127.0.0.1:11434", model = "qwen2.5:7b", fetchImpl = fetch } = {}) {
  return {
    id: `ollama:${model}`,
    async translate(texts, lang) {
      const system = [
        `Translate the user interface strings of a Markdown editor from English to ${LANGUAGE_NAMES[lang] ?? lang}.`,
        "Reply with a JSON object {\"t\": [...]} holding exactly one translation per input string, in the same order.",
        "Keep every token like ⟦0⟧ exactly as it is. Keep keyboard keys (⌘, Esc, Tab, Ctrl), emoji and leading symbols.",
        "Use the usual UI wording of that language; short and plain.",
      ].join(" ");
      const res = await fetchImpl(`${host.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          options: { temperature: 0.2 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(texts) },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const body = await res.json();
      const parsed = JSON.parse(body?.message?.content ?? "{}");
      const list = Array.isArray(parsed) ? parsed : parsed?.t;
      if (!Array.isArray(list) || list.length !== texts.length) throw new Error("Ollama returned a different number of strings");
      return list;
    },
  };
}

/** For tests and dry runs: `[lang] text`, tokens kept. */
export function fakeEngine() {
  return { id: "fake", translate: async (texts, lang) => texts.map((t) => `[${lang}] ${t}`) };
}
