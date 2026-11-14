/**
 * English strings used only by the skills (plan W7.1), which load on
 * demand: they travel with that chunk (src/i18n/lazy/skills.json) instead of
 * the startup bundle.
 */

import english from "../../i18n/lazy/skills.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
