/**
 * English strings used only by ConflictDialog.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/conflictDialog.json) instead of the startup bundle.
 */

import english from "../../i18n/lazy/conflictDialog.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
