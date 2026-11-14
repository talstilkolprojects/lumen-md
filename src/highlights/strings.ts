/**
 * The highlights panel's English strings travel with its lazy chunk
 * (src/i18n/lazy/highlights.json) instead of the startup bundle (plan
 * W1.15). Imported for its side effect by HighlightsPanel.tsx.
 */

import english from "../i18n/lazy/highlights.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
