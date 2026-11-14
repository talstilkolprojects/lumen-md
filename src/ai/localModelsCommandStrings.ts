/**
 * English strings used only by localModelsCommand.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/localModelsCommand.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/localModelsCommand.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
