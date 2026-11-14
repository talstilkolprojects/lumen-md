/**
 * English strings used only by InsertTextDialog.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/insertTextDialog.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/insertTextDialog.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
