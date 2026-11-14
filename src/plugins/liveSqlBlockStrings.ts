/**
 * English strings used only by LiveSqlBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/liveSqlBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/liveSqlBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
