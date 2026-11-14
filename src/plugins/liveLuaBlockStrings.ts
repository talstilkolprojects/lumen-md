/**
 * English strings used only by LiveLuaBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/liveLuaBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/liveLuaBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
