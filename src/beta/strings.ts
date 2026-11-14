/**
 * The beta programme's strings (plan W6.31) travel with its lazy chunk
 * (src/i18n/lazy/betaProgramme.json), not the startup bundle. Imported for
 * its side effect by the panel and the reminder, both loaded on demand.
 */

import english from "../i18n/lazy/betaProgramme.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
