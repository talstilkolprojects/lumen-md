/**
 * English strings used only by SearchDialog.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/searchDialog.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/searchDialog.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
