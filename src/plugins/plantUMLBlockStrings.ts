/**
 * English strings used only by PlantUMLBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/plantUMLBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/plantUMLBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
