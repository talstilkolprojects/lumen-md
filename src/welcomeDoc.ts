/**
 * The welcome document in the UI language (T45): Hebrew for a Hebrew UI,
 * English otherwise, with Mac-style shortcuts rewritten for Windows / Linux.
 */
import { getLocale } from "./i18n";
import { platformKeys } from "./lib/platformKeys";
import { WELCOME_DOC } from "./welcome";
import { WELCOME_DOC_HE } from "./welcome.he";

export function welcomeDoc(locale: string = getLocale()): string {
  return platformKeys(locale === "he" ? WELCOME_DOC_HE : WELCOME_DOC);
}
