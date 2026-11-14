/**
 * Reading aids' English strings (plan W5.6) travel with the dialog's lazy
 * chunk (src/i18n/lazy/readingAids.json), not the startup bundle. The
 * palette names (cmd.reading.*) stay in the startup bundle.
 */

import english from "../i18n/lazy/readingAids.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
