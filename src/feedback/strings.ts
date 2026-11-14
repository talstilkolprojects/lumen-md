/**
 * The feedback dialog's strings (plan 14.2) travel with its lazy chunk
 * (src/i18n/lazy/feedback.json) instead of the startup bundle. Imported for
 * its side effect by src/ui/FeedbackDialog.tsx, which is only ever loaded
 * with a dynamic import.
 */

import english from "../i18n/lazy/feedback.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
