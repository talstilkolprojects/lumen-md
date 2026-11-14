/**
 * English strings used only by TrustedKeysSettings.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/trustedKeysSettings.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/trustedKeysSettings.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
