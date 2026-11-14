/**
 * Journalist mode's English strings travel with its lazy chunks
 * (src/i18n/lazy/journalist.json), not the startup bundle (plan W5.11).
 * Imported for its side effect by the screens that call `t()`.
 */

import english from "../i18n/lazy/journalist.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
