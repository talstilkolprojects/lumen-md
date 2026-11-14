/**
 * "Suggest a better translation" strings (plan W4.18) travel with the
 * dialog's lazy chunk (src/i18n/lazy/translationSuggest.json). The palette
 * name and the beta marks (cmd.i18n.*, locale.*) stay in the startup bundle.
 */

import english from "../i18n/lazy/translationSuggest.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
