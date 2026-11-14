/**
 * The canvas diagram dialog's English strings (plan W2.18) travel with the
 * canvas chunk (src/i18n/lazy/canvasDiagram.json), not the startup bundle.
 * Imported for its side effect by src/canvas/DiagramDialog.tsx.
 */

import english from "../i18n/lazy/canvasDiagram.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
