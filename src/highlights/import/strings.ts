/**
 * Highlight import strings (plan W2.15) travel with their lazy chunk
 * (src/i18n/lazy/highlightImport.json), not the startup bundle. Imported for
 * its side effect by src/highlights/import/runImport.ts.
 */

import english from "../../i18n/lazy/highlightImport.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
