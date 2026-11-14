/**
 * The privacy report's English strings (plan W2.24) travel with the privacy
 * ledger panel's lazy chunk (src/i18n/lazy/privacy.json) instead of the
 * startup bundle. Imported for its side effect by the modules that use them.
 */

import english from "../i18n/lazy/privacy.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
