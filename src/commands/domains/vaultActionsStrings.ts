/**
 * English strings used only by vaultActions.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/vaultActions.json) instead of the startup bundle.
 */

import english from "../../i18n/lazy/vaultActions.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
