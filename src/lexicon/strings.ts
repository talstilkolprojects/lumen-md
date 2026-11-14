/**
 * The lexicon's English strings (plan W5.26) travel with its lazy chunk
 * (src/i18n/lazy/lexicon.json). The palette names (cmd.lexicon.*) stay in
 * the startup bundle.
 */

import english from "../i18n/lazy/lexicon.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
