/**
 * English strings used only by OrgSettings.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/orgSettings.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/orgSettings.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
