/**
 * English strings used only by PrivacyLedgerPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/privacyLedgerPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/privacyLedgerPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
