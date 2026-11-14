/**
 * Which UI languages a native speaker has reviewed (plan W4.18). English is
 * the source and Hebrew is written by native speakers; the other six were
 * machine-translated (plan 9.1) and are "beta" until a native speaker
 * reviews them: the language picker and the palette say so, and the
 * "Suggest a better translation" command opens a prefilled GitHub issue
 * (./suggest.ts), with no server.
 *
 * When a speaker has reviewed a language, change it here to "reviewed" (and
 * list the reviewer in docs/…/contributing/translations.md).
 */
import type { Locale } from "./index";

export type ReviewStatus = "source" | "native" | "reviewed" | "beta";

export const LOCALE_REVIEW: Readonly<Record<Locale, ReviewStatus>> = {
  en: "source",
  he: "native",
  ar: "beta",
  ru: "beta",
  fr: "beta",
  de: "beta",
  ja: "beta",
  "zh-CN": "beta",
};

export const isBetaLocale = (code: string): boolean => LOCALE_REVIEW[code as Locale] === "beta";

/** The languages still waiting for a native speaker. */
export const betaLocales = (): Locale[] => (Object.keys(LOCALE_REVIEW) as Locale[]).filter((l) => LOCALE_REVIEW[l] === "beta");
