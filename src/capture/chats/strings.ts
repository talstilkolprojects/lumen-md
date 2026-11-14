/**
 * The chat import's English (plan W5.7) travels with its lazy chunk
 * (src/i18n/lazy/chatImport.json); imported for its side effect by
 * ./runImport.ts, which the command loads with a dynamic import.
 */

import english from "../../i18n/lazy/chatImport.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
