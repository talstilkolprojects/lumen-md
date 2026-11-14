/**
 * English strings used only by command bodies that load on use (the
 * commands/domains/*Actions.ts modules, plan W4.9): they travel with those
 * chunks (src/i18n/lazy/commandBodies.json) instead of the startup bundle.
 */

import english from "../../i18n/lazy/commandBodies.json";
import { registerEnglish } from "../../i18n";

registerEnglish(english);
