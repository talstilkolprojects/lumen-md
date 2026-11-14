/**
 * English strings used only by TypographyDialog.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/typographyDialog.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/typographyDialog.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
