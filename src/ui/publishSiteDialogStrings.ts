/**
 * English strings used only by PublishSiteDialog.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/publishSiteDialog.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/publishSiteDialog.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
