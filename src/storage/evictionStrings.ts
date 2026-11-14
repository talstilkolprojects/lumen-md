/**
 * The Safari eviction reminder's English strings (plan 13.3.3) travel with
 * its lazy chunk (src/i18n/lazy/eviction.json) instead of the startup
 * bundle. Imported for its side effect by src/storage/evictionReminder.ts,
 * which main.tsx loads only with a dynamic import.
 */

import english from "../i18n/lazy/eviction.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
