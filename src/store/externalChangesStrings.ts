/**
 * English strings used only by externalChanges.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/externalChanges.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/externalChanges.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
