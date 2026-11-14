/**
 * The webR download's English strings (plan W1.34) travel with the live-R
 * block's lazy chunk (src/i18n/lazy/webr.json) instead of the startup
 * bundle. Imported for its side effect by src/plugins/LiveRBlock.tsx, which
 * the renderer loads only with a dynamic import.
 */

import english from "../../i18n/lazy/webr.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
