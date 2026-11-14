/**
 * English strings used only by TrashPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/trashPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/trashPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
