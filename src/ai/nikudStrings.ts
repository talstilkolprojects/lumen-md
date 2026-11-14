/**
 * Niqqud's English strings (plan 6.3) travel with its lazy chunk
 * (src/i18n/lazy/nikud.json) instead of the startup bundle. Imported for its
 * side effect by src/ai/nikudService.ts, which the command loads with a
 * dynamic import before it shows any of these strings. The command names
 * (cmd.nikud.*) stay in the startup bundle: the palette lists them.
 */

import english from "../i18n/lazy/nikud.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
