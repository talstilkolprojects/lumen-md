/**
 * English strings used only by CollabSettings.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/collabSettings.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/collabSettings.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
