/**
 * English strings used only by LiveDictation.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/liveDictation.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/liveDictation.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
