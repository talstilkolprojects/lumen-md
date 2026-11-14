/**
 * English strings used only by CalendarPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/calendarPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/calendarPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
