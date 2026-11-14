/**
 * "What's new" strings (plan 14.6) travel with their lazy chunk
 * (src/i18n/lazy/whatsNew.json), not the startup bundle.
 */

import english from "../i18n/lazy/whatsNew.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
