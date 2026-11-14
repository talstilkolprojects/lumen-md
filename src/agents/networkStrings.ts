/**
 * English strings used only by network.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/network.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/network.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
