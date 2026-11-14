/**
 * English strings used only by MarkdownTableEditor.tsx, which loads on demand: they
 * travel with its chunk (src/i18n/lazy/markdownTableEditor.json) instead of the startup bundle.
 */

import english from "../i18n/lazy/markdownTableEditor.json";
import { registerEnglish } from "../i18n";

registerEnglish(english);
