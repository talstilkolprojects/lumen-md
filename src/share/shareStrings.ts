/**
 * The share link's English strings (plan W5.10) travel with its lazy chunks
 * (src/i18n/lazy/shareLink.json) instead of the startup bundle. Imported for
 * its side effect by the share dialog and the viewer, which are only loaded
 * with a dynamic import.
 */

import english from "../i18n/lazy/shareLink.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
