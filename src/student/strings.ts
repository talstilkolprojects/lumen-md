/** Student mode's English strings travel with its chunk (src/i18n/lazy/student.json), not the startup bundle (plan W5.13). */
import english from "../i18n/lazy/student.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
