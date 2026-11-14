/**
 * English strings used only by FirstRun.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/firstRun.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/firstRun.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
