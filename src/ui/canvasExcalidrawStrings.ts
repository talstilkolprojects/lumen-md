/**
 * English strings used only by CanvasExcalidraw.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/canvasExcalidraw.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/canvasExcalidraw.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
