/**
 * The "Train AI on my style" panel's English strings travel with its lazy
 * chunk (src/i18n/lazy/fineTune.json) instead of the startup bundle (plan
 * W1.13 freed startup bytes this way). Imported for its side effect by
 * FineTuneSettings.tsx, the only module that shows them.
 */

import english from "../i18n/lazy/fineTune.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
