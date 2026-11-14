/**
 * The usage dialog's and reminder's strings (plan W4.26) travel with their
 * lazy chunk (src/i18n/lazy/usage.json), not the startup bundle.
 */

import english from "../i18n/lazy/usage.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
