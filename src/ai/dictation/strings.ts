/**
 * File transcription's English strings travel with its lazy chunk
 * (src/i18n/lazy/transcribeFile.json) instead of the startup bundle (plan
 * W1.17). Imported for its side effect by src/ui/TranscribeFile.ts, the only
 * module that shows them.
 */

import english from "../../i18n/lazy/transcribeFile.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
