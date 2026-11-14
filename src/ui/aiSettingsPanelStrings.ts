/**
 * English strings used only by AiSettingsPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/aiSettingsPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/aiSettingsPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
