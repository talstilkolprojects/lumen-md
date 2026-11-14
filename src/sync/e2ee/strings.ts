/**
 * The encrypted sync's English strings travel with its lazy chunk
 * (src/i18n/lazy/e2ee.json) instead of the startup bundle. Imported for its
 * side effect by every module of this domain that calls `t()`.
 */

import english from "../../i18n/lazy/e2ee.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
