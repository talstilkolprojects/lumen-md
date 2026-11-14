/**
 * The AI doctor's stage-6 strings (plan 7.4) travel with the doctor's lazy
 * chunk (src/i18n/lazy/doctor.json) instead of the startup bundle. Imported
 * for its side effect by src/ui/AiDoctorPanel.tsx, which App.tsx loads with
 * React.lazy.
 */

import english from "../i18n/lazy/doctor.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
