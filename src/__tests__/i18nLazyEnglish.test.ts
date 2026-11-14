/**
 * English of lazily loaded domains (src/i18n/lazy/<domain>.json): kept out
 * of the startup bundle, registered when the domain's chunk loads.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { lazyEnglish, LAZY_DIR } from "./helpers/i18nLazy";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";
import { registerEnglish, t } from "../i18n";

const SRC = resolve(__dirname, "..");

/**
 * Each lazy file, the one strings module that imports it, and the modules
 * allowed to import that strings module — all of them reached only through
 * a dynamic import, so the strings never join the startup bundle. `within`:
 * a folder that is itself loaded only lazily (nothing outside it imports it
 * statically); the users may import each other statically inside it.
 */
const DOMAINS: Record<string, { module: string; users: string[]; prefixes: string[]; within?: string; shared?: string[] }> = {
  "caption.json": { module: "ai/captionStrings.ts", users: ["ai/caption.ts"], prefixes: ["caption."] },
  "nikud.json": { module: "ai/nikudStrings.ts", users: ["ai/nikudService.ts"], prefixes: ["toast.nikud.", "models.purpose.nikud", "nikud.alt."] },
  "eviction.json": { module: "storage/evictionStrings.ts", users: ["storage/evictionReminder.ts"], prefixes: ["storage.eviction."] },
  "analyst.json": { module: "agents/analystStrings.ts", users: ["agents/analyst.ts"], prefixes: ["analyst.", "cmd.ai.analyse.ask"] },
  "lora.json": { module: "ai/localLoraStrings.ts", users: ["ui/FineTuneSettings.tsx", "ui/LocalLoraSection.tsx"], prefixes: ["lora.", "fineTune.cloudRoute"] },
  "doctor.json": { module: "agents/doctorStrings.ts", users: ["ui/AiDoctorPanel.tsx"], prefixes: ["ai.doctor."] },
  "imageSearch.json": { module: "ai/imageSearchStrings.ts", users: ["ui/SearchDialog.tsx", "ui/ImageSearchPanel.tsx", "ai/imageSearchService.ts"], prefixes: ["imageSearch."] },
  "mt.json": { module: "ai/mt/strings.ts", users: ["ai/mt/index.ts", "agents/commands.ts"], prefixes: ["models.", "mt.", "toast.translatedWith", "toast.localMtUnavailable"] },
  // Encrypted sync (plan 3.4): the whole of src/sync/e2ee/ loads on demand.
  // `shared`: the string-free crypto helpers the encrypted vault (plan 11.4) and the backups (age) use too; they may be
  // imported from outside, and must not reach the strings.
  "e2ee.json": {
    module: "sync/e2ee/strings.ts",
    users: ["sync/e2ee/classroom/ClassroomPanel.tsx", "sync/e2ee/conflict.ts", "sync/e2ee/ui/FreshnessBanner.tsx", "sync/e2ee/ui/LanPairing.tsx", "sync/e2ee/ui/PassphraseForm.tsx", "sync/e2ee/ui/SetupWizard.tsx", "sync/e2ee/ui/SyncActivity.tsx", "sync/e2ee/ui/SyncPanel.tsx", "sync/e2ee/ui/SyncRulesForm.tsx", "sync/e2ee/ui/errorText.ts", "sync/e2ee/ui/treeBadges.ts"],
    prefixes: ["e2ee."],
    within: "sync/e2ee/",
    shared: ["sync/e2ee/age.ts", "sync/e2ee/bytes.ts", "sync/e2ee/kdf.ts", "sync/e2ee/kdfCalibrate.ts", "sync/e2ee/primitives/argon2.ts", "sync/e2ee/primitives/blake2b.ts", "sync/e2ee/primitives/chacha20poly1305.ts", "sync/e2ee/primitives/scrypt.ts"],
  },
  "feedback.json": { module: "feedback/strings.ts", users: ["ui/FeedbackDialog.tsx"], prefixes: ["feedback."] },
  // The encrypted vault's dialogs (plan 11.4), opened with a dynamic import.
  "vaultEncryption.json": { module: "storage/vault/encrypted/strings.ts", users: ["ui/VaultEncryptionDialog.tsx", "ui/VaultUnlock.tsx"], prefixes: ["vaultEnc."] },
  // The webR download offer (plan W1.34), in the lazily rendered live-R block.
  "webr.json": { module: "plugins/r/webrStrings.ts", users: ["plugins/LiveRBlock.tsx"], prefixes: ["block.liveR.install."] },
  // The content frame's click-to-load (plan W4.15): the raw-iframe gate and the embed block, both loaded lazily.
  "contentFrame.json": { module: "renderer/contentFrameStrings.ts", users: ["renderer/RemoteFrame.tsx", "plugins/EmbedBlock.tsx"], prefixes: ["remoteFrame.", "block.embed.notEmbeddable", "block.embed.gistDesktop"] },
  // Reading aids (plan W5.6), a dialog opened with a dynamic import.
  "readingAids.json": { module: "reading/readingAidsStrings.ts", users: ["ui/ReadingAids.tsx"], prefixes: ["readingAids."] },
  // The encrypted share link (plan W5.10): the dialog and the read-only viewer, both loaded with a dynamic import.
  "shareLink.json": { module: "share/shareStrings.ts", users: ["share/ShareLinkDialog.tsx", "share/SharedNoteView.tsx"], prefixes: ["shareLink."] },
  // Airplane mode's network monitor (plan W5.9), opened with a dynamic import; the
  // playground and live-js blocks (lazily rendered) say why they don't run while it is on.
  "airplane.json": { module: "privacy/airplaneStrings.ts", users: ["plugins/LiveJsBlock.tsx", "plugins/PlaygroundBlock.tsx", "privacy/NetworkMonitor.tsx"], prefixes: ["airplane."] },
  // The Hebrew lexicon (plan W5.26): its popover and palette actions, both loaded with a dynamic import.
  "lexicon.json": { module: "lexicon/strings.ts", users: ["lexicon/LexiconPopover.tsx", "lexicon/commands.ts"], prefixes: ["lexicon."] },
  // "Suggest a better translation" (plan W4.18), a dialog opened with a dynamic import.
  "translationSuggest.json": { module: "ui/translationSuggestStrings.ts", users: ["ui/TranslationSuggest.tsx"], prefixes: ["i18nSuggest."] },
  // The lazy English the wave-3/4 features brought with them (train 2), each with its strings module.
  "backup.json": { module: "backup/strings.ts", users: ["backup/BackupPanel.tsx", "backup/start.ts"], prefixes: ["backup."], within: "backup/" },
  "canvasCards.json": { module: "canvas/strings.ts", users: ["ui/CanvasExcalidraw.tsx"], prefixes: ["canvas."] },
  "canvasDiagram.json": { module: "canvas/diagramStrings.ts", users: ["canvas/DiagramDialog.tsx"], prefixes: ["canvas."] },
  "capture.json": { module: "capture/strings.ts", users: ["capture/quickCapture.ts", "ui/QuickCapture.tsx"], prefixes: ["capture."] },
  "citations.json": { module: "citations/strings.ts", users: ["citations/CiteDialog.tsx", "citations/LegalCiteDialog.tsx", "citations/run.ts"], prefixes: ["cite.", "legalCite."] },
  "epub.json": { module: "epub/strings.ts", users: ["epub/EpubReader.tsx", "epub/ReadingMode.tsx", "epub/openEpub.ts", "highlights/HighlightsPanel.tsx"], prefixes: ["epub.", "reading."] },
  "fineTune.json": { module: "ui/fineTuneStrings.ts", users: ["ui/FineTuneSettings.tsx"], prefixes: ["fineTune."] },
  "highlightImport.json": { module: "highlights/import/strings.ts", users: ["highlights/import/runImport.ts"], prefixes: ["hlimport."] },
  "highlights.json": { module: "highlights/strings.ts", users: ["highlights/HighlightsPanel.tsx"], prefixes: ["hl."] },
  "importWizard.json": { module: "storage/import/strings.ts", users: ["storage/import/ImportWizard.tsx", "storage/import/report.ts"], prefixes: ["importWizard."], within: "storage/import/" },
  "meetingSpeakers.json": { module: "meetings/speakerStrings.ts", users: ["meetings/meetingTranscribe.ts"], prefixes: ["speakers."] },
  "morning.json": { module: "daily/morningStrings.ts", users: ["daily/morning.ts"], prefixes: ["morning."] },
  "pdf.json": { module: "pdf/strings.ts", users: ["highlights/HighlightsPanel.tsx", "pdf/PdfReader.tsx", "pdf/openPdf.ts"], prefixes: ["pdf."] },
  "pluginDev.json": { module: "plugins/runtime/devStrings.ts", users: ["plugins/runtime/DevPanel.tsx", "plugins/runtime/SandboxedPlugins.tsx"], prefixes: ["pluginDev."], within: "plugins/runtime/", shared: ["plugins/runtime/rendererRegistry.ts"] },
  "pluginTrust.json": { module: "plugins/runtime/trustStrings.ts", users: ["plugins/runtime/permissions.ts"], prefixes: ["pluginTrust."], within: "plugins/runtime/", shared: ["plugins/runtime/rendererRegistry.ts"] },
  "privacy.json": { module: "privacy/strings.ts", users: ["ui/PrivacyLedgerPanel.tsx"], prefixes: ["privacy."] },
  "reading.json": { module: "reading/strings.ts", users: ["ui/ReadingSettings.tsx"], prefixes: ["reading."] },
  "sharing.json": { module: "collab/sharingStrings.ts", users: ["collab/sessionExtras.ts", "ui/ShareDialog.tsx"], prefixes: ["collab.", "share."] },
  "slides.json": { module: "slides/strings.ts", users: ["slides/Presentation.tsx", "slides/PresenterView.tsx"], prefixes: ["slides.", "canvas."], within: "slides/" },
  "srs.json": { module: "srs/strings.ts", users: ["srs/ReviewPanel.tsx"], prefixes: ["srs."] },
  "student.json": { module: "student/strings.ts", users: ["student/LectureRecorder.tsx", "student/lecture.ts"], prefixes: ["student."] },
  "templates.json": { module: "storage/templateStrings.ts", users: ["ui/TemplateGallery.tsx"], prefixes: ["templates."] },
  "transcribeFile.json": { module: "ai/dictation/strings.ts", users: ["ui/TranscribeFile.ts"], prefixes: ["transcribeFile."] },
  "usage.json": { module: "metrics/strings.ts", users: ["metrics/reminder.ts", "ui/UsageDialog.tsx"], prefixes: ["usage."] },
  // The beta programme (plan W6.31): its panel and its weekly reminder, both loaded with a dynamic import.
  "betaProgramme.json": { module: "beta/strings.ts", users: ["beta/reminder.ts", "ui/BetaPanel.tsx"], prefixes: ["beta."] },
  "vaultCheck.json": { module: "storage/vault/integrityStrings.ts", users: ["storage/vault/integrityReport.ts"], prefixes: ["vaultCheck."] },
  "versions.json": { module: "collab/versionStrings.ts", users: ["ui/NamedVersionsDialog.tsx"], prefixes: ["versions."] },
  "voiceCommands.json": { module: "ai/voice/strings.ts", users: ["ai/voice/run.ts"], prefixes: ["voiceCmd."] },
  "whatsNew.json": { module: "whatsNew/strings.ts", users: ["whatsNew/WhatsNewDialog.tsx", "whatsNew/check.ts"], prefixes: ["whatsNew."] },
  // Startup budget (train 2): English that only one lazily loaded module uses travels with that module.
"aiSettingsPanel.json": { module: "ui/aiSettingsPanelStrings.ts", users: ["ui/AiSettingsPanel.tsx"], prefixes: ["ai.settings.available", "ai.settings.browser", "ai.settings.browser.model", "ai.settings.browser.recommended", "ai.settings.browser.tooBig", "ai.settings.checking", "ai.settings.endpoints", "ai.settings.endpoints.hint", "ai.settings.executor.auto", "ai.settings.executor.chat", "ai.settings.executor.ollama", "ai.settings.executor.webllm", "ai.settings.hw.none", "ai.settings.hw.ok", "ai.settings.hw.wasm", "ai.settings.ollama.copyPull", "ai.settings.ollama.installed", "ai.settings.ollama.pull", "ai.settings.ollama.pullFailed", "ai.settings.ollama.pulled", "ai.settings.ollama.pulling", "ai.settings.ollama.unreachable", "ai.settings.recheck", "ai.settings.researchToken", "ai.settings.researchToken.placeholder", "ai.settings.save", "ai.settings.storage", "ai.settings.storage.clearWasm", "ai.settings.storage.clearWebllm", "ai.settings.storage.usage", "ai.settings.style", "ai.settings.style.none", "ai.settings.trace", "ai.settings.trace.clear", "ai.settings.unavailable", "ai.trace.clearConfirm", "ai.trace.testSetup", "pii.settings.hint", "pii.settings.preview", "pii.settings.redact", "pii.settings.title"] },
  "searchDialog.json": { module: "ui/searchDialogStrings.ts", users: ["ui/SearchDialog.tsx"], prefixes: ["vaultCite.", "search.clear", "search.empty", "search.newNote", "search.operatorsHint", "search.save", "search.savedLabel", "search.unsave", "searchDialog.askPlaceholder", "searchDialog.buildHint", "searchDialog.buildIndex", "searchDialog.forget", "searchDialog.hitTitle", "searchDialog.indexing", "searchDialog.localTranslation", "searchDialog.mode.ai", "searchDialog.mode.search", "searchDialog.mode.smart", "searchDialog.monolingualEmbeddings", "searchDialog.noLocalTranslator", "searchDialog.noRelevant", "searchDialog.rebuildIndex", "searchDialog.recent", "searchDialog.recentLabel", "searchDialog.reindex", "searchDialog.relevance", "searchDialog.rerun", "searchDialog.searching", "searchDialog.smartHint", "searchDialog.sources", "searchDialog.thinking", "billing.upgrade.smartSearch", "toast.aiWorkspaceSearchFailed", "toast.buildingSemanticIndex", "toast.indexedFiles", "toast.indexingFailed"] },
  "databaseBlock.json": { module: "views/databaseBlockStrings.ts", users: ["views/DatabaseBlock.tsx"], prefixes: ["db.all", "db.calendar.needDate", "db.calendar.noDates", "db.cell.edit", "db.emptyHint", "db.filter.error", "db.filter.label", "db.filter.placeholder", "db.formula.add", "db.formula.ai", "db.formula.aiFailed", "db.formula.aiHint", "db.formula.aiRunning", "db.formula.cellError", "db.formula.close", "db.formula.computed", "db.formula.error", "db.formula.keepHint", "db.formula.label", "db.formula.name", "db.formula.namePlaceholder", "db.formula.nameTaken", "db.formula.open", "db.formula.placeholder", "db.formula.readOnly", "db.formula.specError", "db.group.label", "db.group.none", "db.kanban.cancelled", "db.kanban.dropped", "db.kanban.instructions", "db.kanban.move", "db.kanban.over", "db.kanban.picked", "db.readOnly", "db.saveFailed", "db.sort.asc", "db.sort.desc", "db.sort.label", "db.sort.none", "db.specError", "db.title", "db.view.calendar", "db.view.cards", "db.view.kanban", "db.view.list", "db.view.map", "db.view.table", "db.workspaceRoot"] },
  "voiceDictation.json": { module: "ui/voiceDictationStrings.ts", users: ["ui/VoiceDictation.tsx"], prefixes: ["dictate.", "voice.memo.recording", "voice.memo.stop", "voice.recording", "voice.stop", "dictation.localRecording", "toast.addedWords", "toast.dictate.localFailed", "toast.dictate.localOnlyBlocked", "toast.dictate.noteClosed", "toast.dictate.onDevice", "toast.dictate.stoppedLocalOnly", "toast.dictate.webSpeechActive", "toast.mediarecorderNotSupportedInThis", "toast.microphoneAccessDenied", "toast.recordingIsNotSupportedIn", "toast.recordingStopped", "toast.speechRecognitionErrorCheckMicrophone", "toast.speechRecognitionNotSupportedIn", "toast.transcribeFailed", "toast.transcribing", "toast.voiceMemoInsertedMs"] },
  "firstRun.json": { module: "onboarding/firstRunStrings.ts", users: ["onboarding/FirstRun.tsx"], prefixes: ["onboard.back", "onboard.failed", "onboard.finish", "onboard.import.done", "onboard.import.failed", "onboard.import.notion", "onboard.import.obsidian", "onboard.import.title", "onboard.lang.change", "onboard.lang.current", "onboard.lang.write", "onboard.lang.write.body", "onboard.next", "onboard.skip", "onboard.start.empty", "onboard.start.empty.desc", "onboard.start.sample", "onboard.start.sample.desc", "onboard.start.title", "onboard.step", "onboard.style.dark", "onboard.style.light", "onboard.style.palette", "onboard.style.system", "onboard.style.theme", "onboard.subtitle", "onboard.title", "onboard.vault.folder", "onboard.vault.folder.chosen", "onboard.vault.folder.denied", "onboard.vault.folder.desc", "onboard.vault.folder.unsupported", "onboard.vault.opfs", "onboard.vault.opfs.desc", "onboard.vault.title", "onboard.working"] },
  "usabilitySessionPanel.json": { module: "ui/usabilitySessionPanelStrings.ts", users: ["ui/UsabilitySessionPanel.tsx"], prefixes: ["usability."] },
  "agentReviewPanel.json": { module: "ui/agentReviewPanelStrings.ts", users: ["ui/AgentReviewPanel.tsx"], prefixes: ["agentReview.approve", "agentReview.approveAll", "agentReview.conflict.doc-changed", "agentReview.conflict.failed", "agentReview.conflict.file-changed", "agentReview.conflict.file-created", "agentReview.conflict.not-open", "agentReview.conflict.open-unsaved", "agentReview.conflict.overlap", "agentReview.done", "agentReview.empty", "agentReview.gap", "agentReview.intro", "agentReview.mcpClient", "agentReview.noEol", "agentReview.proposedBy", "agentReview.reject", "agentReview.rejectAll", "agentReview.run", "agentReview.status.document", "agentReview.status.documentNoUndo", "agentReview.status.file", "agentReview.status.rejected", "agentReview.status.suggestion", "agentReview.status.tab", "agentReview.status.withdrawn", "agentReview.target.document", "agentReview.target.documentPath", "agentReview.target.newFile", "agentReview.title", "agentReview.tooBig"] },
  "doctor2.json": { module: "agents/doctorLazyStrings.ts", users: ["agents/doctor.ts"], prefixes: ["ai.doctor.check.configuredModel", "ai.doctor.check.embed", "ai.doctor.check.executor", "ai.doctor.check.golden", "ai.doctor.check.grammar", "ai.doctor.check.models", "ai.doctor.check.ollama", "ai.doctor.check.ollamaVersion", "ai.doctor.check.policy", "ai.doctor.check.research", "ai.doctor.check.storage", "ai.doctor.check.sw", "ai.doctor.check.tools", "ai.doctor.check.wasm", "ai.doctor.check.webgpu", "ai.doctor.fix.csp", "ai.doctor.fix.docker", "ai.doctor.fix.install", "ai.doctor.fix.origins", "ai.doctor.fix.persist", "ai.doctor.fix.pull", "ai.doctor.fix.pullHebrew", "ai.doctor.fix.remote", "ai.doctor.fix.research", "ai.doctor.fix.settings", "ai.doctor.fix.update", "ai.doctor.fix.webgpu"] },
  "insightsBlock.json": { module: "plugins/insightsBlockStrings.ts", users: ["plugins/InsightsBlock.tsx"], prefixes: ["block.insights.arrayTag", "block.insights.col.bar", "block.insights.col.count", "block.insights.col.probability", "block.insights.col.value", "block.insights.createdMany", "block.insights.createdOne", "block.insights.createdWhere", "block.insights.empty", "block.insights.field", "block.insights.freqSummary", "block.insights.generateFailed", "block.insights.groupBy", "block.insights.groupField", "block.insights.header", "block.insights.noWorkspace", "block.insights.nothing", "block.insights.openedOne", "block.insights.openedSome", "block.insights.parseError", "block.insights.pickArrayField", "block.insights.pickField", "block.insights.probabilityField", "block.insights.showing", "block.insights.tab.charts", "block.insights.tab.conclusions", "block.insights.tab.cooccur", "block.insights.tab.probabilities", "block.insights.tab.records", "block.insights.tab.suggestions", "block.insights.writeFailed"] },
  "orgSettings.json": { module: "ui/orgSettingsStrings.ts", users: ["ui/OrgSettings.tsx"], prefixes: ["org.audit.open", "org.close", "org.domains.add", "org.domains.duplicate", "org.domains.help", "org.domains.invalid", "org.domains.label", "org.domains.remove", "org.localOnly", "org.localOnly.hint", "org.members.directoryHint", "org.members.empty.cta", "org.members.empty.hint", "org.members.empty.title", "org.members.title", "org.members.you", "org.name.label", "org.name.placeholder", "org.save", "org.saveFailed", "org.saved", "org.sso.account", "org.sso.configured", "org.sso.configured.hint", "org.sso.connected", "org.sso.connected.hint", "org.sso.notConfigured", "org.sso.notConfigured.hint", "org.sso.title"] },
  "privacyLedgerPanel.json": { module: "ui/privacyLedgerPanelStrings.ts", users: ["ui/PrivacyLedgerPanel.tsx"], prefixes: ["pii.ledger.redacted", "privacy.blocked", "privacy.cat.cloud-ai", "privacy.cat.cloud-text", "privacy.cat.local-ai", "privacy.cat.model-download", "privacy.cat.monitoring", "privacy.cat.plugin", "privacy.cat.research", "privacy.cat.static-asset", "privacy.cat.third-party", "privacy.clear", "privacy.cloudRequests", "privacy.col.decision", "privacy.col.received", "privacy.col.sent", "privacy.col.time", "privacy.col.where", "privacy.col.why", "privacy.decision.allowed", "privacy.decision.blocked", "privacy.downloads", "privacy.empty", "privacy.footer", "privacy.localRequests", "privacy.onlyLeaving", "privacy.openAiSettings", "privacy.policy", "privacy.policyName.cloud", "privacy.policyName.local-first", "privacy.policyName.local-only", "privacy.staticAssets", "privacy.title"] },
  "gitPullDocs.json": { module: "store/gitPullDocsStrings.ts", users: ["store/gitPullDocs.ts"], prefixes: ["git.alert.corsHint", "git.alert.corsProxyBlocked", "git.alert.corsProxyCleared", "git.alert.corsProxyInvalid", "git.alert.corsProxySaved", "git.conflict.allResolved", "git.conflict.body", "git.conflict.later", "git.conflict.left", "git.conflict.merge", "git.conflict.mine", "git.conflict.takeMine", "git.conflict.takeTheirs", "git.conflict.theirs", "git.conflict.title", "git.prompt.corsProxy", "git.pull.copies", "git.pull.keptDeleted", "git.pull.kindClashes", "git.pull.mergedIntoOpen", "git.pull.summary", "git.pull.upToDate"] },
  "versionHistory.json": { module: "ui/versionHistoryStrings.ts", users: ["ui/VersionHistory.tsx"], prefixes: ["versionHistory."] },
  "publishSiteDialog.json": { module: "ui/publishSiteDialogStrings.ts", users: ["ui/PublishSiteDialog.tsx"], prefixes: ["publish."] },
  "trustedKeysSettings.json": { module: "ui/trustedKeysSettingsStrings.ts", users: ["ui/TrustedKeysSettings.tsx"], prefixes: ["trustedKeys.add.help", "trustedKeys.add.label", "trustedKeys.add.submit", "trustedKeys.added", "trustedKeys.alreadyTrusted", "trustedKeys.builtinBadge", "trustedKeys.close", "trustedKeys.empty", "trustedKeys.error.empty", "trustedKeys.error.notBase64", "trustedKeys.error.notEd25519", "trustedKeys.intro", "trustedKeys.loading", "trustedKeys.remove.aria", "trustedKeys.remove.confirm", "trustedKeys.remove.title", "trustedKeys.removed", "trustedKeys.saveFailed", "trustedKeys.section.builtin", "trustedKeys.section.user"] },
  "externalChanges.json": { module: "store/externalChangesStrings.ts", users: ["store/externalChanges.ts"], prefixes: ["external.conflict.body", "external.conflict.copyName", "external.conflict.failed", "external.conflict.keepMine", "external.conflict.keptCopy", "external.conflict.keptTyping", "external.conflict.title", "external.deleted", "external.merged", "external.reloaded", "external.renamed"] },
  "codeDoctorBlock.json": { module: "plugins/codeDoctorBlockStrings.ts", users: ["plugins/CodeDoctorBlock.tsx"], prefixes: ["block.codeDoctor.charRange", "block.codeDoctor.clean", "block.codeDoctor.col.confidence", "block.codeDoctor.col.count", "block.codeDoctor.col.example", "block.codeDoctor.col.issue", "block.codeDoctor.copied", "block.codeDoctor.copyFailed", "block.codeDoctor.diagnostics", "block.codeDoctor.identical", "block.codeDoctor.noIssues", "block.codeDoctor.original", "block.codeDoctor.repairedTable", "block.codeDoctor.switchHint", "block.codeDoctor.title", "block.codeDoctor.view.compare", "block.codeDoctor.view.diagnose", "block.codeDoctor.view.repaired", "block.common.copy"] },
  "trustedReposDialog.json": { module: "ui/trustedReposDialogStrings.ts", users: ["ui/TrustedReposDialog.tsx"], prefixes: ["trustedRepos."] },
  "runtimeMetricsPanel.json": { module: "ui/runtimeMetricsPanelStrings.ts", users: ["ui/RuntimeMetricsPanel.tsx"], prefixes: ["runtimeMetrics."] },
  "pluginGallery.json": { module: "ui/pluginGalleryStrings.ts", users: ["ui/PluginGallery.tsx"], prefixes: ["pluginGallery.", "toast.issues", "toast.loadedFromRemoteModule", "toast.loremIpsumInserted", "toast.minReadWords", "toast.noHeadingsFound", "toast.noIssuesFound", "toast.tocInsertedAtTop"] },
  "aiDoctorPanel.json": { module: "ui/aiDoctorPanelStrings.ts", users: ["ui/AiDoctorPanel.tsx"], prefixes: ["ai.doctor.action.openSettings", "ai.doctor.action.persist", "ai.doctor.action.pullModel", "ai.doctor.action.retry", "ai.doctor.action.setPolicyLocalFirst", "ai.doctor.close", "ai.doctor.copied", "ai.doctor.copy", "ai.doctor.copyReport", "ai.doctor.golden", "ai.doctor.goldenRunning", "ai.doctor.intro", "ai.doctor.pulling", "ai.doctor.rerun", "ai.doctor.runGolden", "ai.doctor.running", "ai.doctor.status.fail", "ai.doctor.status.ok", "ai.doctor.status.skip", "ai.doctor.status.warn", "ai.doctor.summary", "ai.doctor.title"] },
  "organizerPanel.json": { module: "ui/organizerPanelStrings.ts", users: ["ui/OrganizerPanel.tsx"], prefixes: ["organizer.analysing", "organizer.cancel", "organizer.cancelled", "organizer.failed", "organizer.intro", "organizer.kind.link", "organizer.kind.merge", "organizer.kind.moc", "organizer.kind.tag", "organizer.next", "organizer.none", "organizer.openReview", "organizer.pause", "organizer.paused", "organizer.reading", "organizer.ready", "organizer.resume", "organizer.sent", "organizer.title"] },
  "creditsDialog.json": { module: "ui/creditsDialogStrings.ts", users: ["ui/CreditsDialog.tsx"], prefixes: ["credits."] },
  "canvasExcalidraw.json": { module: "ui/canvasExcalidrawStrings.ts", users: ["ui/CanvasExcalidraw.tsx"], prefixes: ["canvas.dialogLabel", "canvas.jsonCanvas.export", "canvas.jsonCanvas.exported", "canvas.jsonCanvas.failed", "canvas.jsonCanvas.import", "canvas.jsonCanvas.imported", "canvas.jsonCanvas.skipped", "canvas.legacy.convert", "canvas.legacy.convertFailed", "canvas.legacy.converted", "canvas.legacy.converting", "canvas.legacy.found", "canvas.openFailed", "canvas.picker", "canvas.saveFailed", "canvas.title"] },
  "propertiesPanel.json": { module: "ui/propertiesPanelStrings.ts", users: ["ui/PropertiesPanel.tsx"], prefixes: ["props."] },
  "network.json": { module: "agents/networkStrings.ts", users: ["agents/network.ts"], prefixes: ["agents.netConsent.body", "agents.netConsent.credential", "agents.netConsent.exact", "agents.netConsent.ok", "agents.netConsent.perCall", "agents.netConsent.title", "agents.netConsent.untrusted", "agents.netConsent.visits", "agents.netConsent.what.page-address", "agents.netConsent.what.search-query", "agents.netConsent.what.tool-args"] },
  "basesBlock.json": { module: "views/bases/basesBlockStrings.ts", users: ["views/bases/BasesBlock.tsx"], prefixes: ["base."] },
  "templateGallery.json": { module: "ui/templateGalleryStrings.ts", users: ["ui/TemplateGallery.tsx"], prefixes: ["templates.allCategories", "templates.byAuthor", "templates.clearFilter", "templates.close", "templates.contribute", "templates.contributeLink", "templates.downloads", "templates.empty", "templates.error", "templates.installFailed", "templates.installed", "templates.installing", "templates.loading", "templates.rating", "templates.searchPlaceholder", "templates.sort", "templates.sort.downloads", "templates.sort.rating", "templates.title"] },
  "onboardingTour.json": { module: "ui/onboardingTourStrings.ts", users: ["ui/OnboardingTour.tsx"], prefixes: ["onboard.tour.skip", "tour.done", "tour.next", "tour.step.editor.body", "tour.step.editor.title", "tour.step.menu.body", "tour.step.menu.title", "tour.step.statusBar.body", "tour.step.statusBar.title", "tour.step.viewModes.body", "tour.step.viewModes.title", "tour.step.workspace.body", "tour.step.workspace.title"] },
  "useGit.json": { module: "hooks/useGitStrings.ts", users: ["hooks/useGit.ts"], prefixes: ["git.alert.noRepo", "git.alert.pushFailed", "git.alert.statusFailed", "git.defaultCommitMessage", "git.placeholder.name", "git.prompt.cloneUrl", "git.prompt.email", "git.prompt.name", "toast.clonedFilesIntoWorkspace", "toast.cloningRepository", "toast.generatingCommitMessage", "toast.gitIdentitySet", "toast.pulledChangedFiles", "toast.pulling", "toast.pushedToRemote", "toast.pushing"] },
  "commentsPanel.json": { module: "ui/commentsPanelStrings.ts", users: ["ui/CommentsPanel.tsx"], prefixes: ["commentsPanel."] },
  "liveRubyBlock.json": { module: "plugins/liveRubyBlockStrings.ts", users: ["plugins/LiveRubyBlock.tsx"], prefixes: ["block.liveRuby.clear", "block.liveRuby.loadFailed", "block.liveRuby.loadTimeout", "block.liveRuby.loading", "block.liveRuby.prompt", "block.liveRuby.run", "block.liveRuby.state.error", "block.liveRuby.state.idle", "block.liveRuby.state.loading", "block.liveRuby.state.running", "block.liveRuby.state.success", "block.liveRuby.state.timeout", "block.liveRuby.stop", "block.liveRuby.stopped", "block.liveRuby.timedOut", "block.liveRuby.title"] },
  "localModelsCommand.json": { module: "ai/localModelsCommandStrings.ts", users: ["ai/localModelsCommand.ts"], prefixes: ["ai.localModels.auto", "ai.localModels.autoSet", "ai.localModels.cached", "ai.localModels.downloadNow", "ai.localModels.failed", "ai.localModels.message", "ai.localModels.noWebgpu", "ai.localModels.ready", "ai.localModels.recommended", "ai.localModels.selected", "ai.localModels.set", "ai.localModels.title", "ai.localModels.tooBig"] },
  "insertTextDialog.json": { module: "ui/insertTextDialogStrings.ts", users: ["ui/InsertTextDialog.tsx"], prefixes: ["insertText.auto", "insertText.codeLang", "insertText.confirm", "insertText.detect", "insertText.detectedAs", "insertText.hintCancel", "insertText.hintInsert", "insertText.mode", "insertText.mode.append", "insertText.mode.atCursor", "insertText.mode.replace", "insertText.preview", "insertText.smartHelp", "insertText.smartPlaceholder", "insertText.title"] },
  "liveDictation.json": { module: "ui/liveDictationStrings.ts", users: ["ui/LiveDictation.tsx"], prefixes: ["dictation.download.body", "dictation.download.browser", "dictation.download.cancel", "dictation.download.credits", "dictation.download.start", "dictation.download.title", "dictation.downloading", "dictation.listening", "dictation.loading", "dictation.speaking", "dictation.stop"] },
  "playgroundBlock.json": { module: "plugins/playgroundBlockStrings.ts", users: ["plugins/PlaygroundBlock.tsx"], prefixes: ["block.playground.console", "block.playground.errors", "block.playground.frameTitle", "block.playground.preview", "block.playground.prompt", "block.playground.reset", "block.playground.run", "block.playground.runnerBlocked", "block.playground.state.error", "block.playground.state.idle", "block.playground.state.running", "block.playground.state.success", "block.playground.title"] },
  "liveRBlock.json": { module: "plugins/liveRBlockStrings.ts", users: ["plugins/LiveRBlock.tsx"], prefixes: ["block.liveR.clear", "block.liveR.loadFailed", "block.liveR.loadTimeout", "block.liveR.loading", "block.liveR.plot", "block.liveR.prompt", "block.liveR.run", "block.liveR.state.error", "block.liveR.state.idle", "block.liveR.state.loading", "block.liveR.state.running", "block.liveR.state.success", "block.liveR.state.timeout", "block.liveR.stop", "block.liveR.stopped", "block.liveR.timedOut", "block.liveR.title"] },
  "vaultActions.json": { module: "commands/domains/vaultActionsStrings.ts", users: ["commands/domains/vaultActions.ts"], prefixes: ["vault.export.done", "vault.export.doneFolder", "vault.export.failed", "vault.export.folder", "vault.export.where", "vault.export.zip", "vault.prompt.decryptPassword", "vault.prompt.encryptPassword", "toast.digest.readFailed", "toast.documentDecrypted", "toast.documentEncrypted", "toast.documentIsNotEncrypted", "toast.wrongPassword"] },
  "liveJsBlock.json": { module: "plugins/liveJsBlockStrings.ts", users: ["plugins/LiveJsBlock.tsx"], prefixes: ["block.liveJs.clear", "block.liveJs.idle", "block.liveJs.idleHint", "block.liveJs.resetScope", "block.liveJs.resetScope.hint", "block.liveJs.run", "block.liveJs.runStatus", "block.liveJs.scopeReset", "block.liveJs.shared", "block.liveJs.sharedHint", "block.liveJs.title"] },
  "typographyDialog.json": { module: "ui/typographyDialogStrings.ts", users: ["ui/TypographyDialog.tsx"], prefixes: ["typo."] },
  "calendarPanel.json": { module: "ui/calendarPanelStrings.ts", users: ["ui/CalendarPanel.tsx"], prefixes: ["calendar.folder", "calendar.hasNote", "calendar.holidays", "calendar.israel", "calendar.next", "calendar.parasha", "calendar.pattern", "calendar.patternInvalid", "calendar.prev", "calendar.save", "calendar.settings", "calendar.template", "calendar.templateHint", "calendar.today", "calendar.workWeek", "calendar.hebrewDates", "calendar.deadlineMove"] },
  // Israeli time (plan W5.15): the date hints in properties and the database views, both loaded with a dynamic import.
  "israeliTime.json": { module: "daily/israeliTimeStrings.ts", users: ["daily/DateHint.tsx", "views/DatabaseBlock.tsx"], prefixes: ["israeliTime."] },
  "vaultFolderBanner.json": { module: "ui/vaultFolderBannerStrings.ts", users: ["ui/VaultFolderBanner.tsx"], prefixes: ["vault.desktop.choose", "vault.desktop.firstRunBody", "vault.desktop.notNow", "vault.folder.browserStorage", "vault.folder.cancelMove", "vault.folder.interrupted", "vault.folder.moving", "vault.folder.resume", "vault.folder.useBrowser"] },
  "collabSettings.json": { module: "ui/collabSettingsStrings.ts", users: ["ui/CollabSettings.tsx"], prefixes: ["collab.persistent.hint", "collab.persistent.token", "collab.settings.cancel", "collab.settings.cspBlocked", "collab.settings.publicSignaling.hint", "collab.settings.save", "billing.upgrade.persistentCollab"] },
  "liveLuaBlock.json": { module: "plugins/liveLuaBlockStrings.ts", users: ["plugins/LiveLuaBlock.tsx"], prefixes: ["block.liveLua.clear", "block.liveLua.loadFailed", "block.liveLua.prompt", "block.liveLua.run", "block.liveLua.state.error", "block.liveLua.state.idle", "block.liveLua.state.running", "block.liveLua.state.success", "block.liveLua.state.timeout", "block.liveLua.stop", "block.liveLua.stopped", "block.liveLua.timedOut", "block.liveLua.title", "block.liveLua.workerUnavailable"] },
  "graphView.json": { module: "ui/graphViewStrings.ts", users: ["ui/GraphView.tsx"], prefixes: ["graphView.empty", "graphView.openWorkspace", "graphView.stats", "graph.ariaLabel", "graph.filter.property", "graph.filters", "graph.groupBy", "graph.groupBy.folder", "graph.groupBy.none", "graph.groupBy.tag", "graph.groups", "graph.layingOut"] },
  "imageHostsPanel.json": { module: "ui/imageHostsPanelStrings.ts", users: ["ui/ImageHostsPanel.tsx"], prefixes: ["imageHosts."] },
  "pdfChatPanel.json": { module: "pdf/pdfChatPanelStrings.ts", users: ["pdf/PdfChatPanel.tsx"], prefixes: ["pdf.ask.cite", "pdf.ask.dropped", "pdf.ask.indexing", "pdf.ask.notFound", "pdf.ask.ocr", "pdf.ask.placeholder", "pdf.ask.submit", "pdf.ask.thinking", "pdf.ask.title", "pdf.summarize", "pdf.summary.title"] },
  "vaultDoctorActions.json": { module: "commands/domains/vaultDoctorActionsStrings.ts", users: ["commands/domains/vaultDoctorActions.ts"], prefixes: ["doctor."] },
  "auditLog.json": { module: "ui/auditLogStrings.ts", users: ["ui/AuditLog.tsx"], prefixes: ["audit.clearFilters", "audit.close", "audit.col.action", "audit.col.payload", "audit.col.ts", "audit.col.user", "audit.empty", "audit.export", "audit.exportDone", "audit.fetchFailed", "audit.filter.action", "audit.filter.user", "audit.refresh", "audit.rows"] },
  "trashPanel.json": { module: "ui/trashPanelStrings.ts", users: ["ui/TrashPanel.tsx"], prefixes: ["trash.backToNotes", "trash.close", "trash.daysLeft", "trash.deleteForever", "trash.deleteForeverConfirm", "trash.empty", "trash.emptyAll", "trash.emptyAllConfirm", "trash.restore", "trash.title"] },
  "htmlPreviewBlock.json": { module: "plugins/htmlPreviewBlockStrings.ts", users: ["plugins/HtmlPreviewBlock.tsx"], prefixes: ["block.htmlPreview.exitFullscreen", "block.htmlPreview.fullscreen", "block.htmlPreview.openFullscreen", "block.htmlPreview.sanitized", "block.htmlPreview.scriptsOff", "block.htmlPreview.scriptsOn", "block.htmlPreview.title", "block.htmlPreview.toggleScripts"] },
  "untrusted.json": { module: "agents/untrustedStrings.ts", users: ["agents/untrusted.ts"], prefixes: ["agents.untrusted.action.network", "agents.untrusted.action.write", "agents.untrusted.args", "agents.untrusted.body", "agents.untrusted.ok", "agents.untrusted.title"] },
  "litReview.json": { module: "research/litReviewStrings.ts", users: ["research/litReview.ts"], prefixes: ["litReview.field.findings", "litReview.field.limitations", "litReview.field.method", "litReview.field.question", "litReview.field.sample", "litReview.noValue", "litReview.pageLine", "litReview.source", "litReview.verifiedFields", "litReview.view.all", "litReview.view.verifiedOnly"] },
  "queryBlock.json": { module: "views/queryBlockStrings.ts", users: ["views/QueryBlock.tsx"], prefixes: ["query."] },
  "autofillPanel.json": { module: "ui/autofillPanelStrings.ts", users: ["ui/AutofillPanel.tsx"], prefixes: ["autofill.approve", "autofill.approveAll", "autofill.empty", "autofill.hint", "autofill.reject", "autofill.stale", "autofill.title", "autofill.written"] },
  "conflictDialog.json": { module: "sync/cloud/conflictDialogStrings.ts", users: ["sync/cloud/ConflictDialog.tsx"], prefixes: ["sync."] },
  "markdownTableEditor.json": { module: "ui/markdownTableEditorStrings.ts", users: ["ui/MarkdownTableEditor.tsx"], prefixes: ["mdTable."] },
  "csvBlock.json": { module: "plugins/csvBlockStrings.ts", users: ["plugins/CsvBlock.tsx"], prefixes: ["block.csv.refetch", "block.data.aiChart", "block.data.aiGenerating", "block.data.aiNone", "block.data.fetchFailed", "block.data.parseFailed", "toast.aiChartGenerationFailed"] },
  "settingsScreen.json": { module: "ui/settingsScreenStrings.ts", users: ["ui/SettingsScreen.tsx"], prefixes: ["locale.betaNote", "settings.empty", "settings.importFailed", "settings.importRefused", "settings.imported"] },
  "plantUMLBlock.json": { module: "plugins/plantUMLBlockStrings.ts", users: ["plugins/PlantUMLBlock.tsx"], prefixes: ["plantuml.", "block.plantuml.error", "block.plantuml.rendering"] },
  "embedContext.json": { module: "renderer/embedContextStrings.ts", users: ["renderer/embedContext.ts"], prefixes: ["embed.cycle", "embed.depth", "embed.notFound", "embed.sectionNotFound"] },
  "unlinkedMentions.json": { module: "ui/unlinkedMentionsStrings.ts", users: ["ui/UnlinkedMentions.tsx"], prefixes: ["backlinks.changed", "backlinks.link", "backlinks.linkAria", "backlinks.linkFailed", "backlinks.linked", "backlinks.unlinked", "backlinks.unlinkedEmpty"] },
"featureFlagsPanel.json": { module: "ui/featureFlagsPanelStrings.ts", users: ["ui/FeatureFlagsPanel.tsx"], prefixes: ["flag.", "flags.close", "flags.intro.beta", "flags.intro.stable", "flags.off", "flags.on", "flags.reset", "flags.source.channel", "flags.source.override", "flags.stage.beta", "flags.stage.stable", "flags.title", "flags.useDefault"] },
  "mobileKeyboardBar.json": { module: "ui/mobileKeyboardBarStrings.ts", users: ["ui/MobileKeyboardBar.tsx"], prefixes: ["mobileBar.customize", "mobileBar.customize.add", "mobileBar.customize.done", "mobileBar.customize.down", "mobileBar.customize.inRow", "mobileBar.customize.intro", "mobileBar.customize.more", "mobileBar.customize.remove", "mobileBar.customize.reset", "mobileBar.customize.title", "mobileBar.customize.up", "mobileBar.label"] },
  "helpPanel.json": { module: "ui/helpPanelStrings.ts", users: ["ui/HelpPanel.tsx"], prefixes: ["help.back", "help.close", "help.contents", "help.loading", "help.noResults", "help.results", "help.search", "help.title", "help.web"] },
  "desktopShellRun.json": { module: "desktop/desktopShellRunStrings.ts", users: ["desktop/desktopShellRun.ts"], prefixes: ["desktop.tray.capture", "desktop.tray.new", "desktop.tray.quit", "desktop.tray.recent", "desktop.tray.show", "desktop.unknownVault"] },
  "quickCaptureWindow.json": { module: "ui/quickCaptureWindowStrings.ts", users: ["ui/QuickCaptureWindow.tsx"], prefixes: ["desktop.capture.failed", "desktop.capture.hint", "desktop.capture.placeholder", "desktop.capture.title"] },
  "liveSqlBlock.json": { module: "plugins/liveSqlBlockStrings.ts", users: ["plugins/LiveSqlBlock.tsx"], prefixes: ["block.liveSql.loadFailed", "block.liveSql.noResult", "block.liveSql.prompt", "block.liveSql.run", "block.liveSql.title"] },
  "canvasWhiteboard.json": { module: "ui/canvasWhiteboardStrings.ts", users: ["ui/CanvasWhiteboard.tsx"], prefixes: ["canvas.addNote", "canvas.back", "canvas.done", "canvas.new.placeholder", "canvas.new.title", "canvas.switch", "canvas.unsaved", "canvas.zoom"] },
  "relatedPanel.json": { module: "ui/relatedPanelStrings.ts", users: ["ui/RelatedPanel.tsx"], prefixes: ["related."] },
  "tasksBlock.json": { module: "plugins/tasksBlockStrings.ts", users: ["plugins/TasksBlock.tsx"], prefixes: ["tasks.count", "tasks.error.date", "tasks.error.query", "tasks.error.regex", "tasks.group.done", "tasks.group.none", "tasks.group.todo"] },
  "tts.json": { module: "ai/ttsStrings.ts", users: ["ai/tts.ts"], prefixes: ["tts.", "toast.tts."] },
  // Journalist mode (plan W5.11): the note-password flow, the redact command, the settings switch,
  // and the photo-metadata refusals of the editor and Publish site, all behind a dynamic import.
  "journalist.json": {
    module: "lib/journalistStrings.ts",
    users: ["ui/SettingsScreen.tsx", "ui/notePassword.ts"],
    prefixes: ["notePw.", "redact.", "settings.keepImageMetadata", "photoMeta.", "publish.withheld"],
  },
  // The handwriting pad (plan W5.27): the palette command and the preview's double-click load it.
  "ink.json": { module: "ink/inkStrings.ts", users: ["ink/InkPad.tsx", "ink/inkCommand.ts"], prefixes: ["ink."] },
  // Where models download from (plan W4.14), a lazy section of the AI settings.
  "modelSources.json": { module: "ai/modelSourcesStrings.ts", users: ["ui/ModelSourcesSection.tsx"], prefixes: ["modelSources."] },
  // Chat import (plan W5.7): the command loads its module with a dynamic import.
  "chatImport.json": { module: "capture/chats/strings.ts", users: ["capture/chats/runImport.ts"], prefixes: ["chatImport."] },
  // Mail and Takeout import (plan W5.18), loaded the same way.
  "mailImport.json": { module: "capture/mail/strings.ts", users: ["capture/mail/runImport.ts"], prefixes: ["mailImport."] },
  // Academic submission export (plan W5.16): the dialog loads from the palette.
  "academic.json": { module: "ui/academicStrings.ts", users: ["ui/AcademicExportDialog.tsx"], prefixes: ["academic."] },
  // Arabic (plan W5.17): the word list and the tashkeel view, both loaded on use.
  "arabic.json": { module: "ai/arabicStrings.ts", users: ["ai/arabicSpellService.ts", "editor/tashkeelView.ts"], prefixes: ["spell.ar.", "tashkeel."] },
  // No-code automations (plan W5.24): the engine's app layer and the palette's command bodies.
  "automations.json": { module: "automations/automationStrings.ts", users: ["automations/app.ts", "commands/domains/automationsActions.ts"], prefixes: ["automations."] },
  // Book-writing mode (plan W5.8): the book's app layer and the palette's command bodies.
  "book.json": { module: "book/bookStrings.ts", users: ["book/app.ts", "commands/domains/bookActions.ts"], prefixes: ["book."] },
  // Academic LaTeX export (plan W5.22), loaded with the export.
  "latex.json": { module: "latex/latexStrings.ts", users: ["latex/app.ts"], prefixes: ["latex."] },
  // The self-guided usability session (plan W4.25), opened from the palette.
  "usabilitySelf.json": { module: "research/usability/selfStrings.ts", users: ["ui/UsabilitySelfPanel.tsx"], prefixes: ["usabilitySelf."] },
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");

describe("i18n: lazy English", () => {
  const lazy = lazyEnglish();
  // The startup English: every domain file of locales/en/ (plan 0.3).
  const startup = readLocale("en");
  const files = sources(SRC);

  it("every lazy file is declared, and none of its keys is also in the startup bundle", () => {
    expect(readdirSync(LAZY_DIR).sort()).toEqual(Object.keys(DOMAINS).sort());
    for (const f of readdirSync(LAZY_DIR)) expect(Object.keys(JSON.parse(readFileSync(join(LAZY_DIR, f), "utf8")) as object).length, f).toBeGreaterThan(0);
    for (const k of Object.keys(lazy)) expect(k in startup, k).toBe(false);
  });

  it("keys stay inside their domain's prefixes", () => {
    for (const [file, d] of Object.entries(DOMAINS)) {
      const keys = Object.keys(JSON.parse(readFileSync(join(LAZY_DIR, file), "utf8")) as Record<string, string>);
      for (const k of keys) expect(d.prefixes.some((p) => k.startsWith(p)), `${file}: ${k}`).toBe(true);
    }
  });

  it("each file is imported only by its strings module, and that module only by its declared users", () => {
    for (const [file, d] of Object.entries(DOMAINS)) {
      const importers = files.filter((f) => readFileSync(f, "utf8").includes(`i18n/lazy/${file}`)).map(rel);
      expect(importers).toEqual([d.module]);
      const stem = d.module.replace(/\.ts$/, "");
      const users = files
        .filter((f) => f !== join(SRC, d.module))
        .filter((f) => {
          const src = readFileSync(f, "utf8");
          return [...src.matchAll(/import\s+(?:[^"']*from\s+)?["']([^"']+)["']/g)].some((m) => {
            if (!m[1].startsWith(".")) return false;
            return rel(resolve(join(f, ".."), m[1])) === stem;
          });
        })
        .map(rel)
        .sort();
      expect(users).toEqual([...d.users].sort());
    }
  });

  it("the declared users are themselves only loaded with a dynamic import", () => {
    for (const d of Object.values(DOMAINS)) {
      if (d.within) {
        const shared = new Set((d.shared ?? []).map((x) => x.replace(/\.tsx?$/, "")));
        // A shared helper imports nothing but the other shared helpers, so it never reaches the strings.
        for (const x of d.shared ?? []) {
          const f = join(SRC, x);
          for (const m of readFileSync(f, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*from\s+)?["']([^"']+)["']/gm)) {
            expect(shared.has(rel(resolve(join(f, ".."), m[1]))), `${x} imports ${m[1]}`).toBe(true);
          }
        }
        // Nothing outside the lazily loaded folder imports it statically (the shared helpers aside).
        for (const f of files) {
          if (rel(f).startsWith(d.within)) continue;
          const src = readFileSync(f, "utf8");
          for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*from\s+)?["']([^"']+)["']/gm)) {
            if (!m[1].startsWith(".")) continue;
            const target = rel(resolve(join(f, ".."), m[1]));
            if (shared.has(target)) continue;
            expect(target.startsWith(d.within), `${rel(f)} imports ${m[1]} statically`).toBe(false);
          }
        }
        continue;
      }
      for (const u of d.users) {
        const stem = u.replace(/\.tsx?$/, "");
        for (const f of files) {
          if (rel(f) === u) continue;
          const src = readFileSync(f, "utf8");
          for (const m of src.matchAll(/^\s*import\s+(?!type\b)(?:[^"';]*from\s+)?["']([^"']+)["']/gm)) {
            if (!m[1].startsWith(".")) continue;
            expect(rel(resolve(join(f, ".."), m[1])) === stem, `${rel(f)} imports ${u} statically`).toBe(false);
          }
        }
      }
    }
  });

  it("registerEnglish makes t() resolve the keys, without replacing existing English", async () => {
    await import("../sync/e2ee/strings");
    expect(t("e2ee.setup.title")).toBe(lazy["e2ee.setup.title"]);
    expect(t("e2ee.setup.tooShort", { n: 12 })).toBe("At least 12 characters.");
    await import("../ai/mt/strings");
    expect(t("mt.layer.name.opus")).toBe(lazy["mt.layer.name.opus"]);
    expect(t("toast.translatedWith", { layer: "X" })).toBe("Translated with X");
    registerEnglish({ "dialog.ok": "replaced?", "test.lazy.only": "lazy" });
    expect(t("dialog.ok")).toBe("OK");
    expect(t("test.lazy.only")).toBe("lazy");
  });
});
