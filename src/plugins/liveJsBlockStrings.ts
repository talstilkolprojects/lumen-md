/**
 * English strings used only by LiveJsBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/liveJsBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/liveJsBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
