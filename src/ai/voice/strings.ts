/** Voice commands' strings (plan W5.20) travel with their lazy chunk (src/i18n/lazy/voiceCommands.json), not the startup bundle. */
import english from "../../i18n/lazy/voiceCommands.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
