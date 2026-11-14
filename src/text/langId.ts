/**
 * Local language identification (plan 6.5): the script first
 * (./script.ts), then franc-min's trigram model (MIT, ~127 KB) for the
 * scripts many languages share — Latin, Cyrillic, Arabic, Devanagari.
 * Nothing leaves the device.
 *
 * This module imports franc-min, so it is loaded lazily (`await
 * import("../text/langId")`) and never sits in the startup chunk. For
 * higher accuracy on short texts eld (Apache-2.0) is the known fallback,
 * but at ~9 MB it is not shipped.
 *
 * Short texts carry little evidence. Under 30 letters the choice is made
 * among the preferred languages (by default Lumen's eight UI languages: he,
 * en, ar, ru, fr, de, ja, zh) that the text's script has, and the guess is
 * marked not confident; longer texts are matched against every language
 * franc-min knows, with a mild prior for the preferred ones.
 */
import { francAll } from "franc-min";
import { dominantScript, languageFromScript, proseForLanguage, scriptCounts } from "./script";

export interface LanguageGuess {
  /** BCP-47 primary tag ("he", "en", "fa"…), or "und" when there is no language to tell. */
  lang: string;
  script: ReturnType<typeof dominantScript>;
  /** False for very short or ambiguous text: callers should not act on it alone. */
  confident: boolean;
}

/** franc's ISO 639-3 codes → BCP-47 (two letters where one exists). */
const ISO3: Record<string, string> = {
  eng: "en", fra: "fr", deu: "de", spa: "es", por: "pt", ita: "it", nld: "nl", pol: "pl", ron: "ro", tur: "tr", swe: "sv", ces: "cs", hun: "hu",
  ind: "id", zlm: "ms", vie: "vi", tgl: "tl", ceb: "ceb", jav: "jv", sun: "su", swh: "sw", hau: "ha", yor: "yo", ibo: "ig", zul: "zu", som: "so",
  kin: "rw", nya: "ny", run: "rn", lin: "ln", plt: "mg", uzn: "uz", azj: "az", bos: "bs", hrv: "hr", srp: "sr", ckb: "ckb",
  rus: "ru", ukr: "uk", bel: "be", bul: "bg", kaz: "kk",
  arb: "ar", pes: "fa", urd: "ur", pbu: "ps", skr: "skr",
  hin: "hi", mar: "mr", npi: "ne", mai: "mai", bho: "bho", mag: "mag",
};
const toTag = (iso3: string): string => ISO3[iso3] ?? iso3;

/** Every language detectLanguage() can report (besides "und"). */
export const DETECTABLE = new Set([...Object.values(ISO3), "he", "yi", "ja", "zh", "ko", "el", "th"]);

/** Lumen's UI languages: the prior for short, ambiguous text. */
export const UI_LANGUAGES = ["he", "en", "ar", "ru", "fr", "de", "ja", "zh"];

/** Letters that only one language of a script uses (among the common ones). */
function byLetters(script: string, text: string): string | null {
  if (script === "cyrillic") {
    // Only letters one language owns: ў Belarusian; ї є ґ Ukrainian; ђ ћ џ љ њ ј
    // Serbian. (і is Ukrainian and Belarusian, ы э ё Russian and Belarusian,
    // ъ Russian and Bulgarian: those are left to the narrowed model below.)
    if (/[ўЎ]/.test(text)) return "be";
    if (/[їєґЇЄҐ]/.test(text)) return "uk";
    if (/[ђћџљњјЂЋЏЉЊЈ]/.test(text)) return "sr";
  }
  if (script === "arabic") {
    if (/[ٹڈڑںےۓ]/.test(text)) return "ur";
    if (/[پچژگکی]/.test(text) && !/[ةىي]/.test(text)) return "fa";
  }
  return null;
}

/**
 * The most frequent words of the Latin-script UI languages (and their
 * nearest neighbours, so a Spanish or Dutch text is not forced into them).
 * On a short text a function word says more than a few trigrams.
 */
const COMMON: Record<string, string> = {
  en: "the a an and or of to in on at for with from by is are was were be been it this that these those you your we our they their he she his her not no yes can will would should do does did have has had all any some new open save add remove delete show hide edit file files note notes page text first next back more about into out up as if then than what which who how when where there here my me i just like time people year way day thing man world life hand part child eye woman place work week case point government company number group problem fact use make get go know take see come think look want give find tell ask seem feel try leave call good great little own other old right big high different small large long same last only also well even back still just now very much many most such because while through after before over under between without again never always often there why",
  fr: "le la les un une des du de et ou est sont été être avec pour dans sur par pas ne plus au aux ce cette ces vous votre vos nous notre il elle ils elles je tu mon ma mes son sa ses qui que quoi où quand comment tout tous toute très aussi mais donc si en y à ça c'est l'un d'un fichier fichiers ouvrir enregistrer afficher masquer supprimer ajouter nouveau nouvelle être avoir faire dire aller voir savoir pouvoir vouloir venir devoir prendre trouver donner falloir parler mettre passer comme bien sans encore toujours jamais rien peu beaucoup trop autre même entre depuis avant après chez sous contre vers pendant leur leurs lui eux moi toi ici là alors parce puis déjà oui non",
  de: "der die das den dem des ein eine einen einem einer und oder ist sind war waren sein mit für von zu im in am auf aus bei nicht kein keine ich du er sie es wir ihr mein dein ihre unser auch nur noch schon wie was wer wo wenn dann als über unter nach vor alle neu neue datei dateien öffnen speichern anzeigen ausblenden löschen hinzufügen bitte haben werden können müssen sollen wollen machen sagen gehen sehen geben kommen wissen finden bleiben liegen stehen nehmen ganz sehr mehr viel immer wieder hier dort jetzt heute ohne gegen durch zwischen seit bis um so doch mal ja nein nichts etwas jeder jede dieser diese dieses man sich uns euch ihm ihn ihnen",
  es: "el la los las un una unos y o es son está con para por en del al que no se su sus mi tu yo usted nosotros pero como más muy también este esta",
  it: "il lo la gli le un una e o è sono con per in del della di che non si suo sua mio tuo io noi ma come più molto anche questo questa",
  pt: "o a os as um uma e ou é são está com para por em do da dos das que não se seu sua meu eu nós mas como mais muito também este esta você",
  nl: "de het een en of is zijn was met voor van in op aan te niet geen ik je jij hij zij wij ons ook maar als dan wat wie waar dit dat deze",
};
const COMMON_SETS = Object.fromEntries(Object.entries(COMMON).map(([l, w]) => [l, new Set(w.split(" "))]));
const DIACRITICS: Record<string, RegExp> = { de: /[äöüß]/gi, fr: /[éèêàçùâîôûœëï]/gi, es: /[ñ¿¡áíóú]/gi, pt: /[ãõâêôç]/gi };

/** Function-word and diacritic votes for the Latin-script candidates: the best one, if it clearly wins. */
function lexicalVote(text: string, candidates: string[]): string | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const score: Record<string, number> = {};
  for (const l of candidates) {
    const set = COMMON_SETS[l];
    if (!set) continue;
    score[l] = words.filter((w) => set.has(w)).length + 0.5 * (text.match(DIACRITICS[l] ?? /$^/g) ?? []).length;
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] === 0) return null;
  return ranked.length === 1 || ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
}

/** franc's top guesses for one script, as BCP-47 tags with franc's 0–1 scores. */
function trigramGuesses(prose: string, only?: string[]): Array<[string, number]> {
  return francAll(prose, { minLength: 1, ...(only ? { only } : {}) })
    .filter(([code]) => code !== "und")
    .map(([code, score]) => [toTag(code), score] as [string, number]);
}

/**
 * Identify the language of a text. `prefer` (default: the UI languages)
 * decides short texts and wins over the best guess of a longer one when it
 * scores within `margin` of it.
 */
export function detectLanguage(text: string, opts: { prefer?: string[]; margin?: number; shortLetters?: number } = {}): LanguageGuess {
  const prose = proseForLanguage(text).replace(/[\p{N}\p{S}_]+/gu, " ").replace(/\s+/g, " ").trim();
  const script = dominantScript(prose);
  const letters = Object.values(scriptCounts(prose)).reduce((a, b) => a + b, 0);
  if (script === null) return { lang: "und", script, confident: true };
  const fromScript = languageFromScript(prose);
  if (fromScript) return { lang: fromScript, script, confident: letters >= 2 };

  const marked = byLetters(script, prose);
  if (marked) return { lang: marked, script, confident: letters >= 4 };
  // Cyrillic with a letter Russian lacks (і) or one Ukrainian lacks (ы э ё):
  // the model chooses within that pair; a short text takes the first.
  if (script === "cyrillic" && (/[іІ]/.test(prose) || /[ыэёЫЭЁ]/.test(prose))) {
    const pair = /[іІ]/.test(prose) ? ["ukr", "bel"] : ["rus", "bel"];
    const lang = letters < (opts.shortLetters ?? 30) ? toTag(pair[0]) : (trigramGuesses(prose, pair)[0]?.[0] ?? toTag(pair[0]));
    return { lang, script, confident: letters >= 30 };
  }

  // Only the letters of the dominant script go to the model ("PDF" in a
  // Russian sentence is not Russian evidence).
  const sameScript = prose.replace(/\p{L}+/gu, (w) => (dominantScript(w) === script ? w : " ")).replace(/\s+/g, " ").trim() || prose;
  const fallback: Record<string, string> = { latin: "en", cyrillic: "ru", arabic: "ar", devanagari: "hi" };
  const prefer = opts.prefer ?? UI_LANGUAGES;
  const preferIso = Object.keys(ISO3).filter((iso) => prefer.includes(ISO3[iso]));
  const all = trigramGuesses(sameScript);
  if (!all.length) return { lang: fallback[script] ?? "und", script, confident: false };
  // Short text: trigrams over a few words are noise across ~60 languages, so
  // choose among the preferred languages this script has, when it has any.
  const short = letters < (opts.shortLetters ?? 30);
  const preferredHere = all.filter(([tag]) => prefer.includes(tag));
  if (short && preferredHere.length) {
    if (script === "latin") {
      const vote = lexicalVote(sameScript, [...new Set([...prefer.filter((l) => COMMON_SETS[l]), "es", "it", "pt", "nl"])]);
      if (vote) return { lang: vote, script, confident: false };
    }
    const only = trigramGuesses(sameScript, preferIso);
    if (only.length) return { lang: only[0][0], script, confident: false };
  }
  const [best, bestScore] = all[0];
  const preferred = preferredHere[0];
  const pick = preferred && preferred[1] >= bestScore * (opts.margin ?? 0.8) ? preferred[0] : best;
  const second = all.find(([tag]) => tag !== pick)?.[1] ?? 0;
  return { lang: pick, script, confident: letters >= 30 && second < 0.98 };
}

/** The language of a BCP-47 tag or an English/native language name ("French", "עברית"), or null. */
export function languageCode(nameOrTag: string): string | null {
  const t = nameOrTag.trim().toLowerCase();
  const names: Record<string, string> = {
    hebrew: "he", "עברית": "he", ivrit: "he", iw: "he", heb: "he", english: "en", eng: "en", arabic: "ar", "العربية": "ar", arabe: "ar", ara: "ar",
    russian: "ru", "русский": "ru", rus: "ru", french: "fr", "français": "fr", francais: "fr", fra: "fr", german: "de", deutsch: "de", deu: "de",
    japanese: "ja", "日本語": "ja", jp: "ja", chinese: "zh", "中文": "zh", "汉语": "zh", spanish: "es", "español": "es", italian: "it",
    portuguese: "pt", dutch: "nl", swedish: "sv", polish: "pl", turkish: "tr", czech: "cs", ukrainian: "uk", "українська": "uk",
    persian: "fa", farsi: "fa", "فارسی": "fa", urdu: "ur", korean: "ko", "한국어": "ko", bulgarian: "bg", serbian: "sr", greek: "el", hindi: "hi",
  };
  if (names[t]) return names[t];
  const m = /^([a-z]{2,3})(?:[-_][a-z0-9]+)*$/.exec(t);
  return m ? m[1] : null;
}
