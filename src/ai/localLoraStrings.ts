/**
 * The local fine-tune's English strings (plan 6.12) travel with the
 * fine-tune dialog's lazy chunk (src/i18n/lazy/lora.json) instead of the
 * startup bundle. Imported for its side effect by the dialog and its local
 * section; App.tsx loads the dialog with React.lazy.
 */

import english from "../i18n/lazy/lora.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
