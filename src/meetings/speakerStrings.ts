/**
 * Meeting speakers' English strings travel with their lazy chunk
 * (src/i18n/lazy/meetingSpeakers.json) instead of the startup bundle (plan
 * W2.7). Imported for its side effect by src/meetings/meetingTranscribe.ts,
 * the only module that shows them.
 */

import english from "../i18n/lazy/meetingSpeakers.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
