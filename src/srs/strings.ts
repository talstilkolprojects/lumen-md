/**
 * Daily review's English strings travel with its lazy chunk
 * (src/i18n/lazy/srs.json) instead of the startup bundle (plan W3.3).
 * Imported for its side effect by ReviewPanel.tsx.
 */

import english from "../i18n/lazy/srs.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
