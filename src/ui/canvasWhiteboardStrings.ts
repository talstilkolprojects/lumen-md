/**
 * English strings used only by CanvasWhiteboard.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/canvasWhiteboard.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/canvasWhiteboard.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
