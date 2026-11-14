/** W7.19's English strings travel with the publish chunk (src/i18n/lazy/standardSite.json), not the startup bundle. */
import english from "../i18n/lazy/standardSite.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
