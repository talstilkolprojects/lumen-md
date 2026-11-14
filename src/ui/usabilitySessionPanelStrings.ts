/**
 * English strings used only by UsabilitySessionPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/usabilitySessionPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/usabilitySessionPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
