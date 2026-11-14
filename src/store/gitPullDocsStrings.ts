/**
 * English strings used only by gitPullDocs.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/gitPullDocs.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/gitPullDocs.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
