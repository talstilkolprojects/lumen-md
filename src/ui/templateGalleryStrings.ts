/**
 * English strings used only by TemplateGallery.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/templateGallery.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/templateGallery.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
