/**
 * AI doctor, stage 6 (plan 7.4.1): the on-device engines — local translation
 * (6.4), English spelling (6.10), the Hebrew dictionary, niqqud (6.3), image
 * captions (6.6) and the host the self-converted models come from (6.0).
 *
 * Each check reads state only: nothing is downloaded, no model is loaded and
 * no request leaves the page. A check that cannot tell says "skip" and why.
 * Every non-ok finding carries a fix, as in ./doctor.ts.
 */

import type { DoctorFinding } from "./doctor";

/** What the checks read; tests replace any of it. */
export interface EngineProbe {
  /** CONVERTED_MODELS_BASE (null until the host is chosen, plan 15.9). */
  convertedBase: () => string | null;
  /** Registry entries of the self-converted models, by id. */
  registry: () => Promise<Map<string, { files?: Array<{ dtype?: string }> }>>;
  /** Chrome's Translator API, or null. */
  chromeTranslator: () => { availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string> } | null;
  /** The English dictionary loads (it ships in the app). */
  englishSpell: () => Promise<boolean>;
  hebrewDictionary: () => Promise<boolean>;
  storage: Pick<Storage, "getItem"> | null;
}

const OPUS = ["opus-mt-en-he", "opus-mt-tc-big-he-en"] as const;
const NAKDIMON = "nakdimon";
const CAPTION_READY = ["lumen.caption.ready.onnx-community/Florence-2-base-ft", "lumen.caption.ready.HuggingFaceTB/SmolVLM-256M-Instruct"];
const M2M100_READY = "lumen.mt.m2m100.ready";

function safeStorage(): Pick<Storage, "getItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

async function defaultProbe(): Promise<EngineProbe> {
  const [{ CONVERTED_MODELS_BASE, loadConvertedRegistry }, { chromeTranslatorApi }] = await Promise.all([import("../ai/convertedModels"), import("../ai/mt/chromeTranslator")]);
  return {
    convertedBase: () => CONVERTED_MODELS_BASE,
    registry: loadConvertedRegistry,
    chromeTranslator: () => chromeTranslatorApi(),
    englishSpell: async () => {
      const { checkEnglish } = await import("../ai/englishSpellService");
      // One known misspelling: the dictionary is there when it is flagged.
      return (await checkEnglish("recieve")).length > 0;
    },
    hebrewDictionary: async () => (await import("../ai/hebrewSpellService")).hebrewDictionaryInstalled(),
    storage: safeStorage(),
  };
}

const hasFiles = (e: { files?: Array<{ dtype?: string }> } | undefined) => !!e && (e.files ?? []).some((f) => f.dtype !== "config");

const getFlag = (s: EngineProbe["storage"], k: string) => {
  try {
    return s?.getItem(k) === "1";
  } catch {
    return false;
  }
};

/** The stage-6 findings, in the order a user would meet the engines. */
export async function engineFindings(probe?: Partial<EngineProbe>): Promise<DoctorFinding[]> {
  const p: EngineProbe = { ...(await defaultProbe()), ...probe };
  const out: DoctorFinding[] = [];
  const base = p.convertedBase();
  let registry = new Map<string, { files?: Array<{ dtype?: string }> }>();
  try {
    registry = await p.registry();
  } catch {
    /* why: an unreadable registry: every converted model reads as "no files" */
  }

  // The host of the self-converted models (Opus-MT, Nakdimon): none until Tal picks one.
  const missingFiles = [...OPUS, NAKDIMON].filter((id) => !hasFiles(registry.get(id)));
  if (!base) {
    out.push({ id: "engines.host", title: "ai.doctor.check.modelHost", status: "warn", detail: "CONVERTED_MODELS_BASE = null", fix: { label: "ai.doctor.fix.modelHost", url: "https://github.com/talstilkol/lumen-md/blob/plan/local-agents/MASTER_PLAN.md" } });
  } else if (missingFiles.length) {
    out.push({
      id: "engines.host",
      title: "ai.doctor.check.modelHost",
      status: "warn",
      detail: `${base} · ${missingFiles.join(", ")}`,
      fix: { label: "ai.doctor.fix.modelChecksums", command: "gh workflow run model-convert.yml && npm run models:registry -- <run-id>" },
    });
  } else {
    out.push({ id: "engines.host", title: "ai.doctor.check.modelHost", status: "ok", detail: base });
  }

  // Translation: Chrome's layer, then Opus-MT, then M2M100 (6.4).
  {
    const api = p.chromeTranslator();
    let chrome: string = "absent";
    if (api) {
      try {
        chrome = await api.availability({ sourceLanguage: "en", targetLanguage: "he" });
      } catch {
        chrome = "unavailable";
      }
    }
    const opus = !!base && OPUS.every((id) => hasFiles(registry.get(id)));
    const m2m = getFlag(p.storage, M2M100_READY);
    const parts = [`Chrome: ${chrome}`, `Opus-MT: ${opus ? "available" : "not hosted"}`, `M2M100: ${m2m ? "downloaded" : "on first use"}`];
    const local = chrome === "available" || chrome === "downloadable" || chrome === "downloading" || opus;
    out.push({
      id: "engines.translate",
      title: "ai.doctor.check.translate",
      status: local ? "ok" : "warn",
      detail: parts.join(" · "),
      // M2M100 (MIT, ≈ 630 MB) still covers en↔he after consent; the fix says so.
      fix: local ? undefined : { label: "ai.doctor.fix.translate" },
    });
  }

  // English spelling (6.10): the dictionary ships with the app.
  try {
    const ok = await p.englishSpell();
    out.push({ id: "engines.spellEn", title: "ai.doctor.check.spellEn", status: ok ? "ok" : "fail", detail: ok ? "nspell + dictionary-en" : undefined, fix: ok ? undefined : { label: "ai.doctor.fix.reload", action: "retry" } });
  } catch (e) {
    out.push({ id: "engines.spellEn", title: "ai.doctor.check.spellEn", status: "fail", detail: (e as Error).message, fix: { label: "ai.doctor.fix.reload", action: "retry" } });
  }

  // Hebrew spelling: Hspell's list, downloaded only from the user's own command.
  try {
    const ok = await p.hebrewDictionary();
    out.push({ id: "engines.spellHe", title: "ai.doctor.check.spellHe", status: ok ? "ok" : "warn", fix: ok ? undefined : { label: "ai.doctor.fix.spellHe", action: "downloadHebrewDictionary" } });
  } catch (e) {
    out.push({ id: "engines.spellHe", title: "ai.doctor.check.spellHe", status: "skip", detail: (e as Error).message });
  }

  // Niqqud (6.3): Nakdimon from the converted-model host.
  {
    const ok = !!base && hasFiles(registry.get(NAKDIMON));
    out.push({ id: "engines.nikud", title: "ai.doctor.check.nikud", status: ok ? "ok" : "warn", detail: ok ? "Nakdimon" : base ? "nakdimon: no files" : "CONVERTED_MODELS_BASE = null", fix: ok ? undefined : { label: "ai.doctor.fix.modelHost" } });
  }

  // Image captions (6.6): Florence-2, SmolVLM fallback; downloaded with consent on first use.
  {
    const ready = CAPTION_READY.filter((k) => getFlag(p.storage, k));
    out.push({ id: "engines.caption", title: "ai.doctor.check.caption", status: "ok", detail: ready.length ? ready.map((k) => k.split(".").pop()).join(", ") : "on first use (consent)" });
  }

  // Speculative decoding in Ollama ≥ 0.34 (W7.15): the measured tok/s with and without, per model.
  {
    const { readMeasurements } = await import("../ai/speculative");
    const { describeMeasurement } = await import("../ai/speculativeMeasure");
    const all = Object.values(readMeasurements(p.storage));
    out.push({
      id: "engines.speculative",
      title: "ai.doctor.check.speculative",
      // Information, not a problem: a model that has not answered yet is simply not measured yet.
      status: "ok",
      detail: all.length ? all.map(describeMeasurement).join("; ") : "measured after a model first answers on Ollama 0.34+",
    });
  }

  return out;
}
