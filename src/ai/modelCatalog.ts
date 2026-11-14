/**
 * Local models for Hebrew (MASTER_PLAN v3, T27).
 *
 * Which Ollama models to suggest, and in which order, when the user's
 * notes are in Hebrew. The ranking is from the models' published language
 * coverage, not from our own measurement: `measured` stays null until a
 * report from `npm run eval:agents` on real hardware is recorded here
 * (MASTER_PLAN §8, step 3a). The in-browser catalog lives in
 * modelManager.ts; its `multilingual` flag is used the same way.
 */

export type HebrewSupport = "strong" | "good" | "basic" | "none";

export interface OllamaCatalogEntry {
  /** `ollama pull` name. */
  name: string;
  label: string;
  /** Billions of parameters. */
  params: number;
  /** RAM to run it comfortably (q4), GB. */
  ramGB: number;
  hebrew: HebrewSupport;
  tools: boolean;
  /** Hebrew eval score 0–1 from a real run, when there is one. */
  measured: number | null;
  note?: string;
  /**
   * Licence class (models/registry.json, plan 1.7). "conditional" = a custom licence
   * (Llama Community License, Gemma Terms): usable, shown with its notice, never
   * recommended by default.
   */
  licence?: { class: "allowed" | "conditional"; name: string };
  /** false = offered in lists but never picked by recommendOllamaModel (e.g. untested). */
  recommend?: boolean;
}

export const OLLAMA_CATALOG: OllamaCatalogEntry[] = [
  { name: "qwen3:14b", label: "Qwen3 14B", params: 14.8, ramGB: 12, hebrew: "good", tools: true, measured: null, note: "119 languages, tool calling; best open-licence quality that fits 16 GB", licence: { class: "allowed", name: "Apache-2.0" } },
  { name: "qwen3:8b", label: "Qwen3 8B", params: 8, ramGB: 8, hebrew: "good", tools: true, measured: null, note: "119 languages, tool calling", licence: { class: "allowed", name: "Apache-2.0" } },
  { name: "qwen2.5:7b", label: "Qwen2.5 7B", params: 7.6, ramGB: 8, hebrew: "good", tools: true, measured: null, note: "the default: tool calling, decent Hebrew", licence: { class: "allowed", name: "Apache-2.0" } },
  { name: "qwen3:4b", label: "Qwen3 4B", params: 4, ramGB: 4, hebrew: "good", tools: true, measured: null, note: "for 8 GB machines", licence: { class: "allowed", name: "Apache-2.0" } },
  { name: "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF", label: "DictaLM 3.0 1.7B (Hebrew)", params: 1.7, ramGB: 2, hebrew: "strong", tools: false, measured: null, note: "Dicta's Hebrew model; a reasoning ('thinking') variant — not yet tested in Lumen", licence: { class: "allowed", name: "Apache-2.0" }, recommend: false },
  { name: "gemma3:12b", label: "Gemma 3 12B", params: 12, ramGB: 12, hebrew: "strong", tools: false, measured: null, note: "140+ languages", licence: { class: "conditional", name: "Gemma Terms of Use" } },
  { name: "gemma3:4b", label: "Gemma 3 4B", params: 4, ramGB: 5, hebrew: "good", tools: false, measured: null, licence: { class: "conditional", name: "Gemma Terms of Use" } },
  { name: "llama3.1:8b", label: "Llama 3.1 8B", params: 8, ramGB: 8, hebrew: "basic", tools: true, measured: null, licence: { class: "conditional", name: "Llama 3.1 Community License" } },
  { name: "llama3.2:3b", label: "Llama 3.2 3B", params: 3.2, ramGB: 4, hebrew: "basic", tools: true, measured: null, licence: { class: "conditional", name: "Llama 3.2 Community License" } },
];

/** Only open-licence, recommendable models are suggested; conditional ones stay opt-in. */
const recommendable = (e: OllamaCatalogEntry) => e.recommend !== false && e.licence?.class !== "conditional";

const RANK: Record<HebrewSupport, number> = { strong: 3, good: 2, basic: 1, none: 0 };

export type LicenceClass = "allowed" | "conditional" | "forbidden";

/** A model's licence: its class and the name to show the user. */
export interface ModelLicence {
  class: LicenceClass;
  name: string;
}

const LLAMA: ModelLicence = { class: "conditional", name: "Llama Community License" };
const GEMMA: ModelLicence = { class: "conditional", name: "Gemma Terms of Use" };
const COHERE: ModelLicence = { class: "forbidden", name: "CC-BY-NC-4.0 (non-commercial)" };
const QWEN_RESEARCH: ModelLicence = { class: "forbidden", name: "Qwen Research License (non-commercial)" };
const QWEN_LICENSE: ModelLicence = { class: "forbidden", name: "Qwen License" };

/**
 * Installed models the catalog does not list by name or family: every Llama
 * and Gemma release (and fine-tunes named after them, e.g. a Llama-based Hermes) is under a
 * custom licence; Cohere's open weights — Aya, Command R / R+ / R7B /
 * A (c4ai-* on Hugging Face) — are CC-BY-NC (models/registry.json, plan 1.7).
 * Matched at the start of a name part, so vendor-prefixed Hugging Face names
 * count too ("Meta-Llama-3.1-8B-Instruct-GGUF", "dolphin-llama3"), but not
 * "tinyllama" (Apache-2.0).
 */
const FAMILY_LICENCE: Array<{ re: RegExp; licence: ModelLicence }> = [
  // Hermes is a fine-tune: Llama's licence only on a Llama base (Hermes-2-Pro-Mistral-7B is Apache-2.0).
  { re: /(^|[-_.])(llama|codellama|hermes(?!.*(mistral|mixtral|qwen|yi-)))/i, licence: LLAMA },
  { re: /(^|[-_.])(gemma|codegemma)/i, licence: GEMMA },
  { re: /(^|[-_.])(aya|command-[ar]|c4ai)/i, licence: COHERE },
];

/**
 * Sizes of an open-licence family that are under another licence
 * (models/registry.json): Qwen2.5 3B and Qwen2.5-Coder 3B are the Qwen
 * Research License (non-commercial) and Qwen2.5 72B the Qwen License, while
 * the other sizes are Apache-2.0. Checked before a tag inherits its
 * family's licence: `tag` for Ollama tags (name:size), `leaf` for the
 * last part of a Hugging Face name (hf.co/<owner>/<Model-Size-…-GGUF>).
 */
const SIZE_EXCEPTIONS: Array<{ tag: RegExp; leaf: RegExp; licence: ModelLicence }> = [
  { tag: /^qwen2\.5:3b(-|$)/i, leaf: /(^|[-_.])qwen2\.5-3b([-_.]|$)/i, licence: QWEN_RESEARCH },
  { tag: /^qwen2\.5:72b(-|$)/i, leaf: /(^|[-_.])qwen2\.5-72b([-_.]|$)/i, licence: QWEN_LICENSE },
  { tag: /^qwen2\.5-coder:3b(-|$)/i, leaf: /(^|[-_.])qwen2\.5-coder-3b([-_.]|$)/i, licence: QWEN_RESEARCH },
];

/**
 * The licence of an installed (possibly tagged or namespaced) model name:
 * the catalog entry, a size exception, its catalog family, then the name.
 * null = unknown.
 */
export function ollamaLicence(name: string): ModelLicence | null {
  const base = name.replace(/:latest$/, "");
  const exact = OLLAMA_CATALOG.find((e) => e.name === base);
  if (exact?.licence) return exact.licence;
  const family = base.split(":")[0];
  const leaf = family.split("/").pop() ?? family;
  const size = SIZE_EXCEPTIONS.find((x) => x.tag.test(base) || x.leaf.test(leaf));
  if (size) return size.licence;
  const fam = OLLAMA_CATALOG.find((e) => e.name.split(":")[0] === family && e.licence);
  if (fam?.licence) return fam.licence;
  return FAMILY_LICENCE.find((f) => f.re.test(leaf))?.licence ?? null;
}

/** The licence class of an installed model name (see ollamaLicence). null = unknown. */
export function licenceClassOf(name: string): LicenceClass | null {
  return ollamaLicence(name)?.class ?? null;
}

/**
 * The licence to name before the user picks an installed Ollama model by
 * hand, or null for an open-licence (or unknown) one: custom-licence and
 * non-commercial models are shown with their licence and confirmed first.
 */
export function ollamaLicenceNotice(name: string): ModelLicence | null {
  const l = ollamaLicence(name);
  return l && l.class !== "allowed" ? l : null;
}

/**
 * May an agent run this installed model without the user choosing it?
 * Custom-licence (conditional) and forbidden models need an explicit pick
 * (`lumen.ollama.model`), like the recommendation above (plan 1.7).
 */
export function autoPickable(name: string): boolean {
  const c = licenceClassOf(name);
  return c !== "conditional" && c !== "forbidden";
}

/** How well a (possibly tagged) installed model name handles Hebrew. */
export function hebrewSupportOf(name: string): HebrewSupport | null {
  const base = name.replace(/:latest$/, "");
  const exact = OLLAMA_CATALOG.find((e) => e.name === base);
  if (exact) return exact.hebrew;
  const family = base.split(":")[0];
  const fam = OLLAMA_CATALOG.filter((e) => e.name.split(":")[0] === family);
  if (fam.length) return fam.reduce((b, e) => (RANK[e.hebrew] > RANK[b.hebrew] ? e : b)).hebrew;
  if (/aya|dictalm|hebrew/i.test(base)) return "strong";
  return null;
}

/**
 * The model to suggest pulling. For Hebrew notes: the best Hebrew model
 * with an open licence that fits the RAM (measured score first when there is one); otherwise
 * the default tool-calling model. `ramGB` unknown → assume 8 GB.
 */
export function recommendOllamaModel(opts: { hebrew: boolean; ramGB?: number | null; tools?: boolean }): OllamaCatalogEntry {
  const ram = opts.ramGB ?? 8;
  const offer = OLLAMA_CATALOG.filter(recommendable);
  const fits = offer.filter((e) => e.ramGB <= Math.max(ram, 4) && (!opts.tools || e.tools));
  const pool = fits.length ? fits : offer.filter((e) => !opts.tools || e.tools);
  if (!opts.hebrew) return pool.find((e) => e.name === "qwen2.5:7b") ?? pool[0];
  return [...pool].sort(
    (a, b) => (b.measured ?? -1) - (a.measured ?? -1) || RANK[b.hebrew] - RANK[a.hebrew] || b.params - a.params,
  )[0];
}

/**
 * Are the user's notes in Hebrew? The UI locale, or the open note being
 * mostly Hebrew letters.
 */
export function prefersHebrew(locale: string | null | undefined, sample: string | null | undefined): boolean {
  if (locale === "he") return true;
  const letters = (sample ?? "").slice(0, 4000).match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return false;
  return letters.filter((c) => /\p{Script=Hebrew}/u.test(c)).length / letters.length >= 0.3;
}
