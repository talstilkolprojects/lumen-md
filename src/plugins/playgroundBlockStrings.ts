/**
 * English strings used only by PlaygroundBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/playgroundBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/playgroundBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
