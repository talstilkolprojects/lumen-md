/**
 * Vault encryption's English strings travel with its lazy chunk
 * (src/i18n/lazy/vaultEncryption.json), not the startup bundle. Imported for
 * its side effect by the screens that call `t()` (plan 11.4).
 */

import english from "../../../i18n/lazy/vaultEncryption.json";
import { registerEnglish } from "../../../i18n";

registerEnglish(english);
