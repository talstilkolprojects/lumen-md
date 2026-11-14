/**
 * Image search's English strings (plan 6.7) travel with the search dialog's
 * lazy chunk (src/i18n/lazy/imageSearch.json) instead of the startup bundle.
 * Imported for its side effect by the dialog, the Images tab and the
 * service; all three are only loaded with a dynamic import.
 */

import english from "../i18n/lazy/imageSearch.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
