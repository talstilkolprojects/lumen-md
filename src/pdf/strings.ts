/**
 * The PDF reader's English strings travel with its lazy chunk
 * (src/i18n/lazy/pdf.json) instead of the startup bundle (moved with plan
 * W1.14 to make room for the EPUB reader). Imported for its side effect by
 * the PDF modules that show them.
 */

import english from "../i18n/lazy/pdf.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
