/**
 * English strings used only by AiDoctorPanel.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/aiDoctorPanel.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/aiDoctorPanel.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
