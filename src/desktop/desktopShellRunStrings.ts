/**
 * English strings used only by desktopShellRun.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/desktopShellRun.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/desktopShellRun.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
