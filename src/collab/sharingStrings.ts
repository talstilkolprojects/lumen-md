/**
 * Sharing's English strings (plan W1.19) travel with the share dialog's
 * lazy chunk (src/i18n/lazy/sharing.json) instead of the startup bundle.
 * Imported for its side effect by every module of this domain that calls `t()`.
 */

import english from "../i18n/lazy/sharing.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
