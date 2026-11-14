/**
 * English strings used only by CreditsDialog.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/creditsDialog.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/creditsDialog.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
