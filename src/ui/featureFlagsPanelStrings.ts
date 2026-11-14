/**
 * English strings used only by FeatureFlagsPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/featureFlagsPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/featureFlagsPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
