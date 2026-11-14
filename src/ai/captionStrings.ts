/**
 * Image captioning's English strings (plan 6.6) travel with its lazy chunk
 * (src/i18n/lazy/caption.json) instead of the startup bundle. Imported for
 * its side effect by src/ai/caption.ts, which is only loaded with a dynamic
 * import.
 */

import english from "../i18n/lazy/caption.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
