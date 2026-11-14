/**
 * English strings used only by RelatedPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/relatedPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/relatedPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
