/**
 * The palette's sections in palette order. Domains interleave because the
 * single-file list did (plan 0.2 kept its order); commandIds.test.ts pins it.
 */
import type { Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";
import { buildFileCommands, buildRecentCommands, buildTemplateCommands, buildTrashCommands, buildWorkspaceFileCommands } from "./file";
import { buildExportCommands } from "./export";
import { buildLanguageCommands, buildPanelCommands, buildThemeToggleCommands, buildViewCommands } from "./view";
import { buildEditCommands, buildInsertCommands } from "./edit";
import { buildHebrewDictionaryCommands, buildPluginCommands, buildWritingGoalCommands } from "./tools";
import { buildAiCancelCommands, buildAiCapabilityCommands, buildAiControlCommands, buildAiModelCommands, buildAiProviderCommands, buildPrivacyModeCommands } from "./ai";
import { buildAltTextCommands, buildDocumentAgentCommands, buildGrammarCommands, buildPromptTemplateCommands } from "./agents";
import { buildBatchCommands } from "./batch";
import { buildResearchCommands } from "./research";
import { buildDigestCommands, buildEncryptionCommands, buildVaultDoctorCommands, buildVaultTransferCommands } from "./vault";
import { buildVaultLocationCommands } from "./vaultLocation";
import { buildReadAloudCommands, buildVoiceCommands } from "./voice";
import { buildGitCommands } from "./git";
import { buildCollabCommands, buildCommentCommands } from "./collab";
import { buildBillingCommands, buildOptionalPanelCommands } from "./settings";

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
  buildVaultTransferCommands,
  buildVaultLocationCommands,
  buildTrashCommands,
  buildAiCancelCommands,
  buildReadAloudCommands,
  buildDigestCommands,
  buildAltTextCommands,
  buildAiControlCommands,
  buildGrammarCommands,
  buildLanguageCommands,
  buildPanelCommands,
  buildOptionalPanelCommands,
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
];
