/**
 * English strings used only by embedContext.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/embedContext.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/embedContext.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
