/**
 * English strings used only by GraphView.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/graphView.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/graphView.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
