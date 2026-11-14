/**
 * English strings used only by the date hints in properties (DateHint.tsx)
 * and the database views (DatabaseBlock.tsx), both loaded on demand: they
 * travel with those chunks (src/i18n/lazy/israeliTime.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/israeliTime.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
