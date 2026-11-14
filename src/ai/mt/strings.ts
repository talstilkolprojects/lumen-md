/**
 * Local translation's English strings (plan 6.4) and the converted-model
 * consent dialog's (plan 6.0) travel with their lazy chunks
 * (src/i18n/lazy/mt.json) instead of the startup bundle. Imported for its
 * side effect by every module that resolves these keys.
 */

import english from "../../i18n/lazy/mt.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
