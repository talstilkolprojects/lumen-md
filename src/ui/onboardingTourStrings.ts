/**
 * English strings used only by OnboardingTour.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/onboardingTour.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/onboardingTour.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
