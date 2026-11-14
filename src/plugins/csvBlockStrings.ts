/**
 * English strings used only by CsvBlock.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/csvBlock.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/csvBlock.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
