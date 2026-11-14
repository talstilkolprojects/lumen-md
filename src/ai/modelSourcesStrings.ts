/**
 * The model-sources section's English (plan W4.14) travels with its lazy
 * chunk (src/i18n/lazy/modelSources.json). Imported for its side effect by
 * src/ui/ModelSourcesSection.tsx, which the AI settings load lazily.
 */

import english from "../i18n/lazy/modelSources.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
