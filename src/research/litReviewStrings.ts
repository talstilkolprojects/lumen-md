/**
 * English strings used only by litReview.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/litReview.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/litReview.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
