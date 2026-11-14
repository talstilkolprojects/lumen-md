/**
 * English strings used only by vaultDoctorActions.ts, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/vaultDoctorActions.json) instead of the startup bundle.
 */

import english from "../../i18n/lazy/vaultDoctorActions.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
