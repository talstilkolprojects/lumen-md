/**
 * The handwriting pad's English strings (plan W5.27) travel with its lazy
 * chunk (src/i18n/lazy/ink.json), not the startup bundle. The palette
 * command's name (cmd.insert.ink) stays in the startup bundle.
 */
import english from "../i18n/lazy/ink.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
