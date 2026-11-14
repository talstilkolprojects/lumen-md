/**
 * English strings used only by AutofillPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/autofillPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/autofillPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
