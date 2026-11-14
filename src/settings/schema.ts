/**
 * Every persisted setting and stored value, in one table (plan 11.1).
 *
 * Two places hold state across reloads:
 *   - `app`: a field of the zustand store persisted under `lumen-md`
 *     (`partialize` in store/useStore.ts);
 *   - `local`: a key of its own in localStorage (`*` in a key stands for
 *     a variable part, e.g. the provider in `lumen.ai.key.*`).
 *
 * `kind` decides what the settings screen and its export may do:
 *   - `setting`: a user choice; exported, imported, and searchable;
 *   - `secret`: an API key or token; never exported, never imported;
 *   - `data`: content, caches, history and bookkeeping; never exported.
 *
 * `tab` names the settings tab that edits the entry, so a search for a
 * setting finds the tab even when the field lives inside an existing
 * dialog. `label` is an i18n key; an entry without one is not shown on
 * its own (its tab edits it).
 *
 * The schema test (settingsSchema.test.ts) scans the sources and fails
 * when a stored key or persisted field is missing here.
 *
 * Pure data: no imports, so the test and the export code load it alone.
 */

export type SettingsTab = "general" | "appearance" | "ai" | "privacy" | "sync" | "fineTune" | "security" | "org";

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "settings.general" },
  { id: "appearance", label: "themeSettings.title" },
  { id: "ai", label: "ai.settings.title" },
  // Plan W1.30 (W10.C18): the image hosts the user chose "Always allow" for, each revocable.
  { id: "privacy", label: "settings.privacy" },
  { id: "sync", label: "collab.settings.title" },
  { id: "fineTune", label: "fineTune.title" },
  { id: "security", label: "trustedKeys.title" },
  { id: "org", label: "org.title" },
];

export type SettingKind = "setting" | "secret" | "data";

export type SettingType = "boolean" | "choice" | "number" | "text" | "json";

export interface SettingEntry {
  /** Store field (`app`) or localStorage key (`local`). */
  id: string;
  store: "app" | "local";
  kind: SettingKind;
  tab?: SettingsTab;
  label?: string;
  /** How the general tab edits the value, and how an import validates it. */
  type?: SettingType;
  /** `boolean` stored as text: [off, on]; an empty string means "no key". */
  values?: readonly [off: string, on: string];
  /** `choice`: the allowed values (a label is an i18n key). */
  options?: ReadonlyArray<{ value: string; label?: string }>;
  /** `number` bounds, inclusive. */
  min?: number;
  max?: number;
}

const app = (id: string, rest: Omit<SettingEntry, "id" | "store">): SettingEntry => ({ id, store: "app", ...rest });
const local = (id: string, rest: Omit<SettingEntry, "id" | "store">): SettingEntry => ({ id, store: "local", ...rest });
const data = (id: string): SettingEntry => ({ id, store: "local", kind: "data" });
const secret = (id: string, tab: SettingsTab): SettingEntry => ({ id, store: "local", kind: "secret", tab });

export const SETTINGS: readonly SettingEntry[] = [
  // ── The persisted app store (`lumen-md`) ──────────────────────────────
  data("lumen-md"),
  app("mode", {
    kind: "setting", tab: "general", label: "toolbar.viewMode", type: "choice",
    options: [
      { value: "source", label: "mode.source" },
      { value: "split", label: "mode.split" },
      { value: "preview", label: "mode.preview" },
      { value: "wysiwyg", label: "mode.wysiwyg" },
    ],
  }),
  app("theme", {
    kind: "setting", tab: "general", label: "themeSettings.title", type: "choice",
    options: [
      { value: "light", label: "toolbar.lightMode" },
      { value: "dark", label: "toolbar.darkMode" },
      { value: "system" },
    ],
  }),
  app("locale", {
    kind: "setting", tab: "general", label: "settings.language", type: "choice",
    // Labels are the languages' own names (SUPPORTED_LOCALES), not i18n keys.
    options: [
      { value: "en" }, { value: "he" }, { value: "ar" }, { value: "ru" },
      { value: "fr" }, { value: "de" }, { value: "ja" }, { value: "zh-CN" },
    ],
  }),
  app("rtl", { kind: "setting", tab: "general", label: "cmd.view.rtl.on", type: "boolean" }),
  app("showOutline", { kind: "setting", tab: "general", label: "outline.title", type: "boolean" }),
  app("showWorkspace", { kind: "setting", tab: "general", label: "tree.title", type: "boolean" }),
  app("showBacklinks", { kind: "setting", tab: "general", label: "backlinks.title", type: "boolean" }),
  app("showCalendar", { kind: "setting", tab: "general", label: "calendar.title", type: "boolean" }),
  app("pageView", { kind: "setting", tab: "general", label: "desc.pageView", type: "boolean" }),
  app("syncScroll", { kind: "setting", tab: "general", label: "desc.syncScroll", type: "boolean", values: ["single", "all"] }),
  app("splitAxis", {
    kind: "setting", tab: "general", label: "toolbar.splitAxis", type: "choice",
    options: [
      { value: "auto", label: "toolbar.splitAxis.auto" },
      { value: "horizontal", label: "toolbar.splitAxis.horizontal" },
      { value: "vertical", label: "toolbar.splitAxis.vertical" },
    ],
  }),
  app("vimEnabled", { kind: "setting", tab: "general", label: "cmd.view.vim.on", type: "boolean" }),
  app("typewriterMode", { kind: "setting", tab: "general", label: "cmd.view.typewriter.on", type: "boolean" }),
  app("spellCheck", { kind: "setting", tab: "general", label: "cmd.view.spellCheck.on", type: "boolean" }),
  app("grammarCheck", { kind: "setting", tab: "general", label: "cmd.view.grammarCheck.on", type: "boolean" }),
  app("tsChecks", { kind: "setting", tab: "general", label: "cmd.view.tsChecks.on", type: "boolean" }),
  app("suggestingMode", { kind: "setting", tab: "general", label: "status.suggesting.on", type: "boolean" }),
  app("autoSave", { kind: "setting", tab: "general", label: "cmd.view.autoSave.on", type: "boolean" }),
  app("autoSaveInterval", { kind: "setting", tab: "general", type: "number", min: 1000, max: 3_600_000 }),
  app("writingGoalWords", { kind: "setting", tab: "general", label: "cmd.tools.writingGoal.unset", type: "number", min: 0, max: 100_000 }),
  app("useLocalAi", { kind: "setting", tab: "general", label: "cmd.ai.local.hint", type: "boolean" }),
  app("dailyNotes", { kind: "setting", tab: "general", type: "json" }),
  app("themeSettings", { kind: "setting", tab: "appearance", label: "cmd.settings.theme.hint", type: "json" }),
  app("useFineTunedModel", { kind: "setting", tab: "fineTune", label: "fineTune.useToggle", type: "boolean" }),
  app("fineTunedModelId", { kind: "setting", tab: "fineTune", type: "text" }),
  app("doc", { kind: "data" }),
  app("openTabs", { kind: "data" }),

  // ── General ───────────────────────────────────────────────────────────
  local("lumen.telemetry.optOut", { kind: "setting", tab: "general", label: "settings.telemetryOptOut", type: "boolean", values: ["", "1"] }),
  local("lumen-sidebar-width", { kind: "setting", tab: "general", type: "number", min: 120, max: 2000 }),
  local("lumen.marketplace.url", { kind: "setting", tab: "general", type: "text" }),
  local("lumen.digest.folder", { kind: "setting", tab: "general", type: "text" }),
  local("lumen.tasks.reminders", { kind: "setting", tab: "general", type: "boolean", values: ["", "1"] }),
  // W5.11: photos keep their GPS, time and camera details (pasting and exporting) only when this is on.
  local("lumen.images.keepMetadata", { kind: "setting", tab: "general", label: "settings.keepImageMetadata", type: "boolean", values: ["", "1"] }),

  // ── AI (the AI settings panel, model manager included) ────────────────
  local("lumen.ai.policy", { kind: "setting", tab: "ai", label: "cmd.ai.policy", type: "choice", options: [{ value: "local-only" }, { value: "local-first" }, { value: "cloud" }] }),
  local("lumen.ai.mode", { kind: "setting", tab: "ai", label: "cmd.ai.mode", type: "choice", options: [{ value: "economy" }, { value: "balanced" }, { value: "quality" }] }),
  local("lumen.ai.provider", { kind: "setting", tab: "ai", label: "cmd.ai.provider", type: "text" }),
  local("lumen.ai.model.local-webgpu", { kind: "setting", tab: "ai", label: "cmd.ai.localModels", type: "text" }),
  local("lumen.ai.model.*", { kind: "setting", tab: "ai", type: "text" }),
  local("lumen.ai.executor", { kind: "setting", tab: "ai", label: "ai.settings.executor", type: "text" }),
  local("lumen.ollama.baseUrl", { kind: "setting", tab: "ai", label: "ai.settings.ollama.url", type: "text" }),
  local("lumen.ollama.model", { kind: "setting", tab: "ai", label: "ai.settings.ollama.model", type: "text" }),
  local("lumen.grammar.endpoint", { kind: "setting", tab: "ai", label: "ai.settings.grammar", type: "text" }),
  local("lumen.research.endpoint", { kind: "setting", tab: "ai", label: "ai.settings.research", type: "text" }),
  local("lumen.research.provider", { kind: "setting", tab: "ai", type: "text" }),
  // A consent: like the other opt-ins, never taken from an imported file.
  data("lumen.research.webConsent"),
  local("lumen.ai.rerank", { kind: "setting", tab: "ai", label: "cmd.ai.rerankModel", type: "choice", options: [{ value: "lexical" }, { value: "model" }] }),
  local("lumen.ai.imageText", { kind: "setting", tab: "ai", label: "cmd.image.altText", type: "boolean", values: ["off", ""] }),
  local("lumen.ai.styleProfile.active", { kind: "setting", tab: "ai", label: "ai.settings.style.use", type: "boolean", values: ["", "1"] }),
  local("lumen.fim.enabled", { kind: "setting", tab: "ai", type: "boolean", values: ["", "1"] }),
  local("lumen.fim.model", { kind: "setting", tab: "ai", type: "text" }),
  local("lumen.ai.redact", { kind: "setting", tab: "ai", type: "boolean", values: ["off", "on"] }),
  local("lumen.ai.redact.preview", { kind: "setting", tab: "ai", type: "boolean", values: ["0", "1"] }),
  local("lumen.ai.authorship.hidden", { kind: "setting", tab: "ai", type: "boolean", values: ["", "1"] }),
  // Opt-ins that send text or audio off the device are not taken from an
  // imported file: the user turns each on here, where it is explained.
  data("lumen.dictate.webSpeech"),
  data("lumen.tts.networkVoices"),
  secret("lumen.ai.key.*", "ai"),
  secret("lumen.research.searchKey", "ai"),
  secret("lumen.research.serviceToken", "ai"),
  // The endpoint the service token is bound to: importing it would send the token elsewhere.
  secret("lumen.research.tokenEndpoint", "ai"),

  // ── Sync and collaboration ────────────────────────────────────────────
  local("lumen.collab.signaling", { kind: "setting", tab: "sync", label: "collab.settings.signalingHint", type: "text" }),
  local("lumen.collab.publicSignaling", { kind: "setting", tab: "sync", label: "collab.settings.publicSignaling", type: "boolean", values: ["", "1"] }),
  local("lumen.collab.ws", { kind: "setting", tab: "sync", label: "collab.persistent.label", type: "text" }),
  local("lumen.git.watch", { kind: "setting", tab: "sync", label: "cmd.git.watch", type: "boolean", values: ["", "1"] }),
  local("lumen.git.identity.v1", { kind: "setting", tab: "sync", type: "json" }),
  local("lumen.cloud.dropbox.folder", { kind: "setting", tab: "sync", type: "text" }),
  secret("lumen.collab.wsToken", "sync"),
  secret("lumen.collab.password", "sync"),
  secret("lumen.git.token.v1", "sync"),
  secret("lumen.cloud.github.token", "sync"),
  secret("lumen.cloud.dropbox.token", "sync"),
  secret("lumen.cloud.dropbox.refresh", "sync"),
  secret("lumen.cloud.gdrive.token", "sync"),
  secret("lumen.cloud.gdrive.refresh", "sync"),
  // OAuth PKCE verifiers live only for one sign-in round trip.
  secret("lumen.cloud.dropbox.pkce", "sync"),
  secret("lumen.cloud.gdrive.pkce", "sync"),
  // The provider settings kept for one OAuth sign-in round trip (sessionStorage).
  secret("lumen-sync-pending-oauth", "sync"),
  secret("lumen.sync.webdav.password", "sync"),
  secret("lumen.sync.s3.secretAccessKey", "sync"),
  secret("lumen.publish.github.token", "sync"),
  // The git CORS proxy sees the git traffic, token included: not imported.
  data("lumen.git.corsProxy.v1"),

  // ── Security and organization ─────────────────────────────────────────
  // Trust anchors and the org policy are not taken from an imported file:
  // a settings file from elsewhere must not add a plugin-signing key.
  local("lumen.plugins.trusted-keys", { kind: "data", tab: "security", label: "cmd.settings.trustedKeys.hint" }),
  local("lumen.org.settings", { kind: "data", tab: "org", label: "cmd.settings.organization.hint" }),
  local("lumen.vaultLock.minutes", { kind: "setting", tab: "security", type: "number", min: 0, max: 1440 }),
  // Trust and consent choices, like the trust anchors above, are not imported.
  data("lumen.remoteImages.allowedHosts"),
  data("lumen.plantuml.krokiOptIn"),
  data("lumen.monitoring.consent"),
  data("lumen.agents.untrustedNotes"),
  data("lumen.agents.provenanceBackfill.v1"),
  data("lumen.secrets.index"),
  data("lumen.dev.tier"),

  // ── Data: content, caches, history, bookkeeping ───────────────────────
  data("lumen.ai.cache"),
  data("lumen.ai.batches"),
  data("lumen.ai.batch.translations"),
  data("lumen.ai.promptHistory"),
  data("lumen.ai.quota.*"),
  data("lumen.ai.styleProfile"),
  data("lumen.ai.usage.v1"),
  data("lumen.privacy.ledger"),
  data("lumen.fineTune.activeJob"),
  data("lumen.dict.he.v1"),
  data("lumen.digest.last"),
  data("lumen.canvas.last"),
  data("lumen.recents.v1"),
  data("lumen.search.history"),
  data("lumen.templates.downloads"),
  data("lumen.templates.installedNames"),
  data("lumen.publish.mock-store"),
  data("lumen.collab.rooms"),
  data("lumen.ai.authorship"),
  data("lumen.mt.m2m100.ready"),
  data("lumen.caption.ready.*"),
  data("lumen.imageSearch.index.v1"),
  data("lumen.clip.highlights"),
  data("lumen.evictionReminder.shownAt"),
  data("lumen.tasks.reminded"),
  data("lumen.propertyTypes"),
  data("lumen.publishSite.v1"),
  data("lumen.plugin.settings.*"),
  data("lumen-vault-known"),
  data("lumen-config-health"),
  data("lumen-tour-done"),
];

/** True when `key` is the entry's id, or matches it with `*` as a wildcard. */
export function matchesEntry(entry: SettingEntry, key: string): boolean {
  if (!entry.id.includes("*")) return entry.id === key;
  const parts = entry.id.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`).test(key);
}

/** The schema entry for a localStorage key (exact ids win over patterns). */
export function entryForLocalKey(key: string): SettingEntry | undefined {
  const locals = SETTINGS.filter((e) => e.store === "local");
  return locals.find((e) => e.id === key) ?? locals.find((e) => e.id.includes("*") && matchesEntry(e, key));
}

/** The schema entry for a persisted store field. */
export function entryForAppField(field: string): SettingEntry | undefined {
  return SETTINGS.find((e) => e.store === "app" && e.id === field);
}

/**
 * Entries and tabs that match a search: the query is compared with the
 * translated label, the key itself and the tab's title, case-insensitive.
 */
export function searchSettings(
  query: string,
  translate: (key: string) => string,
): { entries: SettingEntry[]; tabs: Set<SettingsTab> } {
  const q = query.trim().toLocaleLowerCase();
  const tabs = new Set<SettingsTab>();
  if (!q) {
    for (const tab of SETTINGS_TABS) tabs.add(tab.id);
    return { entries: SETTINGS.filter((e) => e.kind === "setting" && e.label), tabs };
  }
  const hit = (s: string | undefined) => !!s && s.toLocaleLowerCase().includes(q);
  for (const tab of SETTINGS_TABS) if (hit(translate(tab.label))) tabs.add(tab.id);
  const entries = SETTINGS.filter(
    (e) => !!e.label && !!e.tab && (hit(translate(e.label)) || hit(e.id)),
  );
  for (const e of entries) if (e.tab) tabs.add(e.tab);
  return { entries, tabs };
}
