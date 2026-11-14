/**
 * English strings used only by VoiceDictation.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/voiceDictation.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/voiceDictation.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
