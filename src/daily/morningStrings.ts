/** "Your morning"'s English strings travel with the daily-note chunk (src/i18n/lazy/morning.json), not the startup bundle (plan W5.19). */
import english from "../i18n/lazy/morning.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
