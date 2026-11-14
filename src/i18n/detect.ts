/**
 * Which interface language to start in (plans W4.10, W4.35): the saved
 * choice; else Hebrew when the system lists Hebrew at all (a Hebrew-first
 * product: someone with "en-US, he-IL" reads Hebrew); else the first
 * supported language in the system's list (navigator.languages); else
 * English. public/locale-boot.js does the same
 * before the first paint, so the app never flips direction on start.
 */
import type { Locale } from "./index";

const SUPPORTED: readonly Locale[] = ["en", "he", "ar", "ru", "fr", "de", "ja", "zh-CN"];

export function detectLocale(saved: unknown, languages: readonly string[] | undefined): Locale {
  if (typeof saved === "string" && (SUPPORTED as readonly string[]).includes(saved)) return saved as Locale;
  if (systemHasHebrew(languages)) return "he";
  for (const raw of languages ?? []) {
    const tag = String(raw ?? "").toLowerCase();
    let base = tag.split("-")[0];
    if (base === "iw") base = "he";
    if (base === "zh") {
      if (!/-(tw|hk|mo|hant)\b/.test(tag)) return "zh-CN";
      continue;
    }
    if ((SUPPORTED as readonly string[]).includes(base)) return base as Locale;
  }
  return "en";
}

/** The system's language list, in the browser. */
export function systemLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  return list.filter(Boolean) as string[];
}

/** Does the system list Hebrew anywhere (he, he-IL, or the old code iw)? */
export function systemHasHebrew(languages: readonly string[] | undefined): boolean {
  return (languages ?? []).some((l) => /^(he|iw)(-|$)/i.test(String(l ?? "")));
}
