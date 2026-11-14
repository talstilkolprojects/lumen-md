/**
 * English strings used only by VaultFolderBanner.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/vaultFolderBanner.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/vaultFolderBanner.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
