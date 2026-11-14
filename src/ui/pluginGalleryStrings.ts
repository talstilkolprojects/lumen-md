/**
 * English strings used only by PluginGallery.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/pluginGallery.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/pluginGallery.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
