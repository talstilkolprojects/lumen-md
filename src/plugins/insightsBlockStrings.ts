/**
 * English strings used only by InsightsBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/insightsBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/insightsBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
