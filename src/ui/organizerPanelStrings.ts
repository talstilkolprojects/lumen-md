/**
 * English strings used only by OrganizerPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/organizerPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/organizerPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
