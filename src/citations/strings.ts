/**
 * Citation dialog strings (plan W2.16) travel with their lazy chunk
 * (src/i18n/lazy/citations.json), not the startup bundle. Imported for its
 * side effect by src/citations/CiteDialog.tsx and src/citations/run.ts.
 */

import english from "../i18n/lazy/citations.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
