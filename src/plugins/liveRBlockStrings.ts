/**
 * English strings used only by LiveRBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/liveRBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/liveRBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
