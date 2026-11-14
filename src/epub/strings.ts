/**
 * The EPUB reader's and reading mode's English strings travel with their
 * lazy chunk (src/i18n/lazy/epub.json) instead of the startup bundle (plan
 * W1.14). Imported for its side effect by the modules that show them.
 */

import english from "../i18n/lazy/epub.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
