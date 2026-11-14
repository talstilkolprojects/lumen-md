/**
 * English strings used only by BasesBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/basesBlock.json) instead of the startup bundle.
 */

import english from "../../i18n/lazy/basesBlock.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
