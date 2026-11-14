/**
 * English strings used only by useGit.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/useGit.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/useGit.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
