/**
 * English strings used only by AuditLog.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/auditLog.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/auditLog.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
