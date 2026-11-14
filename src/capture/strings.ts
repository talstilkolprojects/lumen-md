/**
 * Quick and voice capture's English strings travel with the capture chunk
 * (src/i18n/lazy/capture.json) instead of the startup bundle (plan W1.13:
 * the voice button pushed startup over its budget). Imported for its side
 * effect by every capture module that calls `t()`; `capture.title` stays in
 * the `en` block because the command palette and the shortcuts list show it
 * at startup.
 */

import english from "../i18n/lazy/capture.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
