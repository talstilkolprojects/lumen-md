/**
 * The data analyst's English strings (plan 6.15) travel with its lazy chunk
 * (src/i18n/lazy/analyst.json) instead of the startup bundle. The palette
 * command loads this before it asks its question or shows a result; only
 * the command's name and hint are in the startup bundle.
 */

import english from "../i18n/lazy/analyst.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
