/**
 * English strings used only by doctor.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/doctor2.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/doctor2.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
