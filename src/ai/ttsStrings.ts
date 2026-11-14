/**
 * Read-aloud's English strings travel with its lazy chunk
 * (src/i18n/lazy/tts.json) instead of the startup bundle (plan W2.6).
 * Imported for its side effect by src/ai/tts.ts, the only module that shows
 * them; tts.ts itself is loaded with a dynamic import by the palette.
 */

import english from "../i18n/lazy/tts.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
