/**
 * English strings used only by ImageHostsPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/imageHostsPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/imageHostsPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
