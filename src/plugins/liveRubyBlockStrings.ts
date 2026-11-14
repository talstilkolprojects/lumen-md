/**
 * English strings used only by LiveRubyBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/liveRubyBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/liveRubyBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
