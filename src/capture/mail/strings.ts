/**
 * The mail import's English (plan W5.18) travels with its lazy chunk
 * (src/i18n/lazy/mailImport.json); imported for its side effect by
 * ./runImport.ts, which the command loads with a dynamic import.
 */

import english from "../../i18n/lazy/mailImport.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
