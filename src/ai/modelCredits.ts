/**
 * Model credits (plan 1.7 step 5, 6.1): one entry for every model and data
 * file Lumen ships or can download, from models/registry.json, the list
 * the licence gate checks. Each entry carries its name, licence, source,
 * the attribution line, and what that licence asks of us when the model is
 * redistributed or used (the CC BY credit for ivrit.ai, the notices for
 * Apache / MIT, "Built with Llama", the Gemma terms).
 */
import registry from "../../models/registry.json";

export interface RegistryModel {
  id: string;
  kind: string;
  source?: string;
  license: string;
  class: string;
  attribution?: string;
  delivery?: string;
  /** CC BY-SA: true only for a file shipped exactly as published (no adaptation). */
  unmodified?: boolean;
}

/** Licence families and what each requires (credits.req.<family> is the sentence shown). */
export type LicenceFamily = "cc-by" | "cc-by-sa" | "apache" | "mit" | "mpl" | "llama" | "gemma";

export function licenceFamily(license: string): LicenceFamily | null {
  if (/^CC-BY-\d/i.test(license)) return "cc-by";
  if (/^CC-BY-SA-\d/i.test(license)) return "cc-by-sa";
  if (/^Apache-2\.0$/i.test(license)) return "apache";
  if (/^MIT$/i.test(license)) return "mit";
  if (/^MPL-2\.0$/i.test(license)) return "mpl";
  if (/Llama .*Community License/i.test(license)) return "llama";
  if (/^Gemma Terms of Use$/i.test(license)) return "gemma";
  return null;
}

export const LICENCE_URL: Record<LicenceFamily, string> = {
  "cc-by": "https://creativecommons.org/licenses/by/4.0/",
  "cc-by-sa": "https://creativecommons.org/licenses/by-sa/4.0/",
  apache: "https://www.apache.org/licenses/LICENSE-2.0",
  mit: "https://opensource.org/license/mit",
  mpl: "https://www.mozilla.org/MPL/2.0/",
  llama: "https://www.llama.com/llama-downloads/",
  gemma: "https://ai.google.dev/gemma/terms",
};

/** How a model reaches the user: shipped in the app, or downloaded / pulled when asked. */
export const SHIPPED_DELIVERY = new Set(["bundled", "download", "ollama-pull", "user-pull", "user-download"]);
/**
 * Families that are not permissive: the model reaches the user only when they
 * ask for it (a download or a pull). CC BY-SA: attribution, and share-alike
 * for modified weights or data. The one exception (coordinator's decision,
 * V4 sweep of train 4): an unmodified file (`unmodified: true`, not an
 * adaptation) may ship bundled, as the licence allows, with its credit in the
 * credits dialog and a NOTICE next to it (the licence gate checks the NOTICE).
 */
export const DOWNLOAD_ONLY_FAMILIES: ReadonlySet<LicenceFamily> = new Set(["cc-by-sa"]);

export interface ModelCredit {
  id: string;
  name: string;
  kind: string;
  license: string;
  family: LicenceFamily | null;
  licenceUrl: string | null;
  /** How it reaches the user (models/registry.json `delivery`). */
  delivery: string;
  /** Shipped exactly as published (models/registry.json `unmodified`). */
  unmodified: boolean;
  source: string | null;
  attribution: string;
  /** Made in Israel for Hebrew: ivrit.ai, Dicta. Shown first. */
  hebrew: boolean;
}

const HEBREW = /ivrit-ai|ivrit\.ai|dicta-il|\bDicta\b/i;

/** "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF" → "DictaLM-3.0-1.7B-Thinking-GGUF"; "gemma3:4b" stays. */
export function displayName(id: string): string {
  return id.split("/").pop() || id;
}

/** Every model that is not forbidden and reaches the user, Hebrew models first, then by kind and name. */
export function modelCredits(list: readonly RegistryModel[] = (registry as { models: RegistryModel[] }).models): ModelCredit[] {
  return list
    .filter((m) => m.class !== "forbidden" && SHIPPED_DELIVERY.has(m.delivery ?? ""))
    .map((m) => {
      const family = licenceFamily(m.license);
      return {
        id: m.id,
        name: displayName(m.id),
        kind: m.kind,
        license: m.license,
        family,
        licenceUrl: family ? LICENCE_URL[family] : null,
        delivery: m.delivery ?? "",
        unmodified: m.unmodified === true,
        source: m.source ?? null,
        attribution: m.attribution ?? "",
        hebrew: HEBREW.test(`${m.id} ${m.source ?? ""} ${m.attribution ?? ""}`),
      };
    })
    .sort((a, b) => Number(b.hebrew) - Number(a.hebrew) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Why an entry cannot be shown as a proper credit (empty = fine). */
export function creditProblems(c: ModelCredit): string[] {
  const out: string[] = [];
  if (!c.attribution.trim()) out.push("no attribution text");
  if (!c.family) out.push(`no licence requirement known for "${c.license}"`);
  if (!c.source || !/^https:\/\//.test(c.source)) out.push("no https source");
  if (c.family === "cc-by" && !/CC BY/i.test(c.attribution)) out.push("CC BY attribution does not name the licence");
  if (c.family === "cc-by-sa" && !/CC BY-SA/i.test(c.attribution)) out.push("CC BY-SA attribution does not name the licence");
  if (c.family && DOWNLOAD_ONLY_FAMILIES.has(c.family) && c.delivery === "bundled" && !c.unmodified) out.push(`${c.license} is bundled but not marked unmodified: modified or derived content may only reach the user as a download they start`);
  if (c.family === "llama" && !/Llama/.test(c.attribution)) out.push("Llama attribution does not name the licence");
  return out;
}
