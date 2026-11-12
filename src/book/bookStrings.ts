/**
 * Book mode's English strings (plan W5.8) travel with its lazy chunk
 * (src/i18n/lazy/book.json), not the startup bundle.
 */
import english from "../i18n/lazy/book.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
