/**
 * The palette's sections in palette order. Domains interleave because the
 * single-file list did (plan 0.2 kept its order); commandIds.test.ts pins it.
 */
import type { Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";
import { buildFileCommands, buildRecentCommands, buildSyncCommands, buildTemplateCommands, buildTaskCommands, buildTrashCommands, buildWorkspaceFileCommands } from "./file";
import { buildExportCommands } from "./export";
import { buildLanguageCommands, buildPanelCommands, buildThemeToggleCommands, buildViewCommands } from "./view";
import { buildEditCommands, buildInsertCommands } from "./edit";
import { buildHebrewDictionaryCommands, buildPluginCommands, buildUsabilityStudyCommands, buildWritingGoalCommands, buildArabicCommands } from "./tools";
import { buildAiCancelCommands, buildAiCapabilityCommands, buildAiControlCommands, buildAiModelCommands, buildAiProviderCommands, buildPrivacyModeCommands } from "./ai";
import { buildAltTextCommands, buildDocumentAgentCommands, buildGrammarCommands, buildNikudCommands, buildPromptTemplateCommands } from "./agents";
import { buildBatchCommands } from "./batch";
import { buildResearchCommands } from "./research";
import { buildDigestCommands, buildEncryptionCommands, buildVaultDoctorCommands, buildVaultTransferCommands } from "./vault";
import { buildDesktopUpdateCommands, buildVaultLocationCommands, buildWhatsNewCommands, buildFeatureFlagCommands } from "./vaultLocation";
import { buildReadAloudCommands, buildVoiceCommands } from "./voice";
import { buildGitCommands } from "./git";
import { buildCollabCommands, buildCommentCommands } from "./collab";
import { buildBillingCommands, buildOptionalPanelCommands, buildAirplaneCommands } from "./settings";
import { buildAccessibilityCommands } from "./a11y";
import { buildSourceCommands } from "./sources";
import { buildBookCommands } from "./book";
import { buildLatexCommands } from "./latex";

export const COMMAND_SECTIONS: ReadonlyArray<(ctx: CommandContext) => Command[]> = [
  buildRecentCommands,
  buildFileCommands,
  buildExportCommands,
  buildViewCommands,
  buildWritingGoalCommands,
  buildPrivacyModeCommands,
  buildVaultDoctorCommands,
  buildDocumentAgentCommands,
  buildAiProviderCommands,
  buildResearchCommands,
  buildBatchCommands,
  buildAiModelCommands,
  buildHebrewDictionaryCommands,
  buildUsabilityStudyCommands,
  buildArabicCommands,
  buildVaultTransferCommands,
  buildVaultLocationCommands,
  buildDesktopUpdateCommands,
  buildWhatsNewCommands,
  buildFeatureFlagCommands,
  buildTrashCommands,
  buildSyncCommands,
  buildTaskCommands,
  buildAiCancelCommands,
  buildReadAloudCommands,
  buildDigestCommands,
  buildAltTextCommands,
  buildAiControlCommands,
  buildNikudCommands,
  buildGrammarCommands,
  buildLanguageCommands,
  buildPanelCommands,
  buildOptionalPanelCommands,
  buildAirplaneCommands,
  buildCommentCommands,
  buildTemplateCommands,
  buildVoiceCommands,
  buildPluginCommands,
  buildEncryptionCommands,
  buildPromptTemplateCommands,
  buildEditCommands,
  buildBillingCommands,
  buildAiCapabilityCommands,
  buildGitCommands,
  buildCollabCommands,
  buildWorkspaceFileCommands,
  buildThemeToggleCommands,
  buildInsertCommands,
  // Appended (plan W1.23) so the earlier order stays as pinned.
  buildAccessibilityCommands,
  buildSourceCommands,
  buildBookCommands,
  buildLatexCommands,
];
