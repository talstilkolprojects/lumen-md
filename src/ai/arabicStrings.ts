/**
 * Strings of the Arabic tools (plan W5.17): the word-list download and the
 * tashkeel commands' messages travel with their lazy chunks
 * (src/i18n/lazy/arabic.json) instead of the startup bundle. Imported for
 * its side effect by ./arabicSpellService and ../editor/tashkeelView, which
 * are only ever loaded with a dynamic import.
 */

import english from "../i18n/lazy/arabic.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
