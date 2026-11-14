/**
 * The canvas's note-card and export strings (plan W1.16) travel with the
 * canvas chunk (src/i18n/lazy/canvasCards.json) instead of the startup
 * bundle. Imported for its side effect by src/ui/CanvasExcalidraw.tsx.
 */

import english from "../i18n/lazy/canvasCards.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
