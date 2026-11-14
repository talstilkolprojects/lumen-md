/**
 * English strings used only by untrusted.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/untrusted.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/untrusted.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
