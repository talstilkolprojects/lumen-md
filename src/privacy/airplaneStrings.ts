/**
 * Airplane mode's English strings (plan W5.9) travel with the network
 * monitor's lazy chunk (src/i18n/lazy/airplane.json) instead of the startup
 * bundle. Imported for its side effect by src/privacy/NetworkMonitor.tsx.
 */

import english from "../i18n/lazy/airplane.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
