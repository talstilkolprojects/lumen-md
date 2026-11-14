/**
 * The English of "delete attachments too" (plan W7.3) travels with its lazy
 * chunk (src/i18n/lazy/attachmentCleanup.json), not the startup bundle.
 */

import english from "../i18n/lazy/attachmentCleanup.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
