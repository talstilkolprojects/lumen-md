// @vitest-environment node
/**
 * Plan 6.5 — local language detection: script detection, franc-min for the
 * shared scripts, the langid golden set's dev split through the CI harness,
 * and the app's own UI strings in its 8 languages as a local stand-in for
 * Tatoeba (which only CI can download).
 */
import { describe, expect, it } from "vitest";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs module without types
import { loadSet } from "../../scripts/lib/golden.mjs";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";
import { detectLanguage, languageCode } from "../text/langId";
import { dominantScript, languageFromScript, looksYiddish, proseForLanguage } from "../text/script";

const root = resolve(__dirname, "../..");

describe("script", () => {
  it("dominant script, ignoring code, URLs and e-mail addresses", () => {
    expect(dominantScript("שלום לכולם, world")).toBe("hebrew");
    expect(dominantScript("今日は雨です")).toBe("kana");
    expect(dominantScript("我爱北京")).toBe("han");
    expect(dominantScript("12345 😀")).toBeNull();
    expect(dominantScript("המייל: someone.long.name@example.com")).toBe("hebrew");
    expect(proseForLanguage("see `const x = 1` and https://example.com/a/b")).not.toMatch(/const|example/);
  });
  it("languages a script settles on its own", () => {
    expect(languageFromScript("בְּרֵאשִׁית בָּרָא")).toBe("he");
    expect(languageFromScript("コーヒー")).toBe("ja");
    expect(languageFromScript("这是一个测试。")).toBe("zh");
    expect(languageFromScript("https://example.com")).toBe("und");
    expect(languageFromScript("Hello there")).toBeNull();
    expect(looksYiddish("ווי גייט עס?")).toBe(true);
    expect(looksYiddish("מה נשמע?")).toBe(false);
  });
});

describe("detectLanguage", () => {
  it("the shared scripts", () => {
    expect(detectLanguage("Bonjour tout le monde, comment ça va aujourd'hui ?").lang).toBe("fr");
    expect(detectLanguage("Tom ist ein guter Junge.").lang).toBe("de");
    expect(detectLanguage("Thanks!").lang).toBe("en");
    expect(detectLanguage("Привіт, як справи?").lang).toBe("uk");
    expect(detectLanguage("Привет, как дела?").lang).toBe("ru");
    expect(detectLanguage("Добры дзень, як справы? Сёння ў нас вельмі прыгожае надвор'е.").lang).toBe("be");
    expect(detectLanguage("Беларуская мова мае свае асаблівасці і гісторыю, якую варта ведаць кожнаму.").lang).toBe("be"); // ы, і — no ў
    expect(detectLanguage("سلام، حالت چطور است؟").lang).toBe("fa");
    expect(detectLanguage("یہ ایک امتحان ہے").lang).toBe("ur");
    expect(detectLanguage("صباح الخير").lang).toBe("ar");
  });
  it("a long text in a language outside the UI eight", () => {
    const g = detectLanguage("El veloz murciélago hindú comía feliz cardillo y kiwi mientras la cigüeña tocaba el saxofón detrás del palenque de paja.");
    expect(g.lang).toBe("es");
    expect(g.confident).toBe(true);
  });
  it("short text is never confident", () => {
    expect(detectLanguage("Danke schön").confident).toBe(false);
  });
  it("language names and tags", () => {
    expect(languageCode("French")).toBe("fr");
    expect(languageCode("עברית")).toBe("he");
    expect(languageCode("zh-CN")).toBe("zh");
    expect(languageCode("pt_BR")).toBe("pt");
    expect(languageCode("Klingon!")).toBeNull();
  });
});

describe("langid golden set (dev split) and a local stand-in for Tatoeba", () => {
  it("the CI harness scores the committed dev items", async () => {
    // @ts-expect-error — plain .mjs module without types
    const { score } = await import("../../scripts/golden/evals/langid.mjs");
    const { items } = loadSet(join(root, "eval", "golden"), "langid");
    expect(items.length).toBeGreaterThanOrEqual(10);
    const s = await score({ items });
    expect(s.hard_lumen8_accuracy).toBeGreaterThanOrEqual(0.95);
    // The Tatoeba dev part is built by the golden-sets workflow (the agent
    // container cannot reach tatoeba.org); once committed it is scored here.
    if (items.some((i: { part: string }) => i.part === "tatoeba")) expect(s.tatoeba_accuracy).toBeGreaterThanOrEqual(0.95);
  }, 30_000);

  it("≥ 95% on the app's own translated UI strings in its 8 languages", () => {
    // Fully translated strings of ≥ 3 words (≥ 6 characters in ja / zh):
    // a translation that keeps an English word of the source ("Exporter to
    // OPML") is left out — it is not one language.
    // The per-domain layout (plan 0.3): src/i18n/locales/<lang>/<domain>.json.
    const en: Record<string, string> = readLocale("en");
    const latinWords = (t: string) => new Set((t.match(/[A-Za-z]{3,}/g) ?? []).map((w) => w.toLowerCase()));
    const files: Record<string, string> = { he: "he", ar: "ar", de: "de", fr: "fr", ja: "ja", ru: "ru", zh: "zh-CN" };
    const per: Record<string, [number, number]> = {};
    const check = (lang: string, key: string, text: string) => {
      const t = text.replace(/\{[^}]*\}/g, " ").replace(/\\[nt"]/g, " ");
      const enough = lang === "ja" || lang === "zh" ? (t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length >= 6 : (t.match(/\p{L}{2,}/gu) ?? []).length >= 3;
      if (!enough) return;
      if (lang !== "en") {
        const src = latinWords(en[key] ?? "");
        if ([...latinWords(t)].some((w) => src.has(w))) return;
      }
      per[lang] ??= [0, 0];
      per[lang][1]++;
      const got = detectLanguage(t).lang;
      if (got === lang) per[lang][0]++;
      else if (process.env.LANGID_DEBUG) appendFileSync(process.env.LANGID_DEBUG, `MISS ${lang} ${got} ${t.slice(0, 80)}\n`);
    };
    for (const [lang, f] of Object.entries(files)) for (const [k, v] of Object.entries(readLocale(f) as Record<string, string>)) check(lang, k, v);
    for (const [k, v] of Object.entries(en)) check("en", k, v);
    const rates = Object.fromEntries(Object.entries(per).map(([l, [a, n]]) => [l, `${(a / n).toFixed(3)} (${n})`]));
    const [a, n] = Object.values(per).reduce(([x, y], [p, q]) => [x + p, y + q], [0, 0]);
    // LANGID_DEBUG=<file> writes the per-language rates and the misses; the assertion is the bar.
    const summary = JSON.stringify({ all: +(a / n).toFixed(4), n, ...rates });
    if (process.env.LANGID_DEBUG) appendFileSync(process.env.LANGID_DEBUG, `UI-string language accuracy ${summary}\n`);
    expect(Object.keys(per).sort()).toEqual(["ar", "de", "en", "fr", "he", "ja", "ru", "zh"]);
    expect(a / n).toBeGreaterThanOrEqual(0.95);
  }, 30_000);
});

describe("where the app uses it", () => {
  const fr = "Bonjour à tous, voici le compte rendu de la réunion de mardi dernier avec toute l'équipe.";
  const en = "Hello everyone, here are the minutes of last Tuesday's meeting with the whole team.";
  const es = "Hola a todos, aquí está el acta de la reunión del martes pasado con todo el equipo.";

  it("agents: a same-script answer in another language fails; short or mixed answers pass", async () => {
    const { sameLanguage } = await import("../agents/runtime");
    expect((await sameLanguage(fr, en)).ok).toBe(false);
    expect(await sameLanguage(fr, "Bonjour à tous, le compte rendu de la réunion est prêt et partagé avec l'équipe.")).toEqual({ ok: true });
    expect(await sameLanguage(fr, "OK")).toEqual({ ok: true });
    expect((await sameLanguage("שלום לכולם, הנה סיכום הפגישה של יום שלישי עם כל הצוות שלנו", en)).ok).toBe(false); // the script check still runs first
  });

  it("translation: the target language, not just its script", async () => {
    const { checkTranslationLanguage } = await import("../agents/defs");
    expect(await checkTranslationLanguage(fr, en, "French")).toEqual({ ok: true });
    expect((await checkTranslationLanguage(en, en, "French")).ok).toBe(false); // left untranslated
    expect((await checkTranslationLanguage(es, en, "fr")).ok).toBe(false); // Spanish, not French
    expect(await checkTranslationLanguage(es, en, "Klingon")).toEqual({ ok: true }); // unknown target: no opinion
    expect(await checkTranslationLanguage("Oui.", en, "French")).toEqual({ ok: true }); // too short to judge
    const ru = "Всем привет, вот протокол встречи прошлого вторника со всей нашей командой проекта.";
    expect((await checkTranslationLanguage(ru, "皆さん、こんにちは。先週の火曜日の会議の議事録です。", "en-US")).ok).toBe(false); // another script, still not the target
    expect(await checkTranslationLanguage("Hei alle sammen, her er referatet fra møtet forrige tirsdag med hele teamet.", en, "Norwegian Bokmål")).toEqual({ ok: true }); // a target the detector cannot report
  });

  it("grammar: LanguageTool gets the detected language", async () => {
    const { grammarLanguage } = await import("../ai/grammar");
    expect(await grammarLanguage(fr)).toBe("fr");
    expect(await grammarLanguage("Das ist ein kurzer Satz über das Wetter in Berlin und die Arbeit.")).toBe("de-DE");
    expect(await grammarLanguage("ok")).toBe("en-US");
  });

  it("read aloud: a voice per sentence language, the document's for short ones", () => {
    return import("../ai/tts").then(({ langFor }) => {
      expect(langFor(fr, "en", detectLanguage)).toBe("fr");
      expect(langFor("今日は雨です", "en", detectLanguage)).toBe("ja");
      expect(langFor("Oui.", "fr", detectLanguage)).toBe("fr");
      expect(langFor("Oui.", "en", detectLanguage)).toBe("en"); // shared script, short: the document's voice
      expect(langFor("שלום עולם", "en", detectLanguage)).toBe("he-IL");
      // A short sentence whose script the document's language doesn't cover
      // keeps its own voice (Codex 4311169918: Arabic under an English note).
      expect(langFor("نعم", "en", detectLanguage)).toBe("ar");
      expect(langFor("صباح الخير", "en", detectLanguage)).toBe("ar");
      expect(langFor("Спасибо", "en", detectLanguage)).toBe("ru");
      expect(langFor("Спасибо", "ru", detectLanguage)).toBe("ru");
      expect(langFor("コーヒー", "en", detectLanguage)).toBe("ja");
      expect(langFor("東京大学", "ja", detectLanguage)).toBe("ja"); // kanji inside a Japanese document
      expect(langFor("東京大学", "en", detectLanguage)).toBe("zh");
      expect(langFor("σήμερα", "en", detectLanguage)).toBe("el");
    });
  });
});
