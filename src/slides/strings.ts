/**
 * Slides' English strings (plan W2.17) travel with their lazy chunk
 * (src/i18n/lazy/slides.json), not the startup bundle. Imported for its side
 * effect by src/slides/Presentation.tsx and src/slides/PresenterView.tsx.
 */

import english from "../i18n/lazy/slides.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
