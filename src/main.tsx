// Must stay the first import: Trusted Types policies before any DOM sink.
import "./lib/trustedTypesInit";
import "./fonts";
import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UpdateBanner } from "./ui/UpdateBanner";
import { setVaultBackend, createDirectoryHandleBackend } from "./storage/vault";
import { openVaultAtBoot } from "./storage/vault/boot";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { showAiToast } from "./ui/AiToast";
import { ToastContainer } from "./components/Toast";
import { initTelemetry } from "./lib/telemetry";
import { startUsageCounting } from "./metrics/count";
import { initAuth } from "./auth/useAuth";
import { startAutoBackup, startVaultSnapshots } from "./sync/autoBackup";
import { requestPersistentStorage } from "./storage/persistentStorage";
import { initLocale, t } from "./i18n";
import { initSecretStore } from "./lib/secretStore";
import { installPrivacyLedger } from "./ai/privacyLedger";
import { installAiEscape } from "./ai/aiAbort";
import { adoptBootLocale } from "./store/useStore";
import "./index.css";

// Every AI network request is recorded; local-only blocks cloud ones (T37).
const lastBlockToast = new Map<string, number>();
installPrivacyLedger((entry) => {
  // One toast per destination per 30 s — a retrying caller mustn't flood.
  if (Date.now() - (lastBlockToast.get(entry.host) ?? 0) < 30_000) return;
  lastBlockToast.set(entry.host, Date.now());
  showAiToast(t("toast.privacyBlocked", { reason: entry.reason }), "error");
});
// Playwright specs reach the app's modules through window.__lumenTest: on the
// dev server, and in a build made with VITE_E2E=1 (a preview's e2e gate).
// A production build drops this branch and src/testing/ (W4.2).
if (import.meta.env.DEV || __LUMEN_E2E__) void import("./testing/e2eHooks").then((m) => m.installE2eHooks());
// Esc cancels any running AI request (T55).
installAiEscape((n) => showAiToast(t("toast.aiCancelled", { count: n }), "info"));
// Error reports: only when the user turned them on AND the build has a DSN (12.4).
void initTelemetry();
void initAuth();
startAutoBackup();
startVaultSnapshots();
// Usage counters on this device only (plan W4.26), loaded after start-up; nothing is sent.
setTimeout(startUsageCounting, 3000);
// Task reminders (plan 4.13.4), only when the user turned them on; loaded after start-up.
try {
  if (localStorage.getItem("lumen.tasks.reminders") === "1") setTimeout(() => void import("./tasks/reminders").then((m) => m.startReminders()), 5000);
} catch {
  /* why: storage blocked: no reminders */
}
// The vault lives in OPFS/IndexedDB; without this the browser may evict it.
// Safari grants persistence to installed apps only and deletes the rest after
// seven days without a visit: remind once a week to export or install (13.3.3).
void requestPersistentStorage().then((status) => {
  if (status !== "persisted") void import("./storage/evictionReminder").then((m) => m.remindIfEvictable(status));
});

// Web Vitals, measured on this device and never sent (12.4): shown in the
// Runtime metrics panel. Loaded off the startup path; the observers are
// buffered, so the page-load entries are still seen.
void import("./lib/webVitals").then((m) => m.startLocalVitals()).catch(() => {
  /* why: chunk failed to load — no local vitals this session */
});

// ─── Native Sync Dialog Capture (Milkdown overrides) ────────────────────
const nativePrompt = window.prompt;
window.prompt = function(message?: string, _defaultText?: string): string | null {
  if (message?.toLowerCase().includes("link") || message?.toLowerCase().includes("image") || message?.toLowerCase().includes("url")) {
    setTimeout(() => {
      showAiToast(t("toast.useTheFloatingMenuOr"), "info");
    }, 50);
    return null; // Aborts synchronous execution block
  }
  return nativePrompt.call(window, message, _defaultText);
};

// ─── iOS Share Extension — listen for shared note content
function initShareExtension() {
  if (typeof window === "undefined") return;
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<{ content?: string }>;
    const content = customEvent.detail?.content;
    if (!content) return;
    // Store the shared note content; App.tsx will pick it up on mount
    (window as unknown as Record<string, unknown>).__pendingSharedNote = content;
  };
  // Capacitor bridge fires a custom document event with shared content
  window.addEventListener("lumen:sharedNote", listener);
}
initShareExtension();

// Only the English string table ships in the main chunk (A7 lever 4).
// Load the persisted locale's lazy bundle BEFORE the first render so the
// synchronous t() calls never flash English for a Hebrew/French/… user.
// initLocale() resolves to English on any failure, so boot never blocks.
// Secrets (API keys, tokens) are decrypted into memory before the first
// render so synchronous reads see them (T36); never blocks boot for long.
const secretsReady = Promise.race([initSecretStore(), new Promise((r) => setTimeout(r, 1500))]);
// Where the vault lives (OPFS or a real folder, plan 4.2) is restored before
// the first render, so nothing reads the wrong store; bounded like secrets.
// Until it is known, the vault is closed (an unavailable backend), never the
// default store by accident; the location module loads on demand.
const VaultFolderBanner = React.lazy(() => import("./ui/VaultFolderBanner").then((m) => ({ default: m.VaultFolderBanner })));
const closedVault = createDirectoryHandleBackend({ id: "restoring", available: () => false, root: async () => Promise.reject(new Error("The vault is still opening.")) });
setVaultBackend(closedVault);
/**
 * Changes made outside Lumen reach the open tabs (plan 4.4) — started once
 * the vault is known (once, even when openVaultAtBoot retries the load), and
 * the open notes are checked against the disk again whenever another vault
 * opens (reconnect, late restore, move).
 */
let externalChangesStarted = false;
function startExternalChanges(m: typeof import("./storage/vault/location")): void {
  if (externalChangesStarted) return;
  externalChangesStarted = true;
  void import("./store/externalChanges").then((x) => {
    x.startExternalChanges();
    let last = m.getVaultStatus().location;
    m.onVaultStatusChange(() => {
      const now = m.getVaultStatus().location;
      if (now === last) return;
      last = now;
      void x.reconcileOpenNotes();
    });
  });
}
// If the location chunk can't load (offline after an update), openVaultAtBoot
// retries it when the browser is back online and shows a "Try again" bar.
const vaultReady = Promise.race([
  openVaultAtBoot({
    load: () =>
      import("./storage/vault/location").then(async (m) => {
        const { detachWorkspaceDocs } = await import("./store/vaultDocs");
        m.setOnVaultReplaced(detachWorkspaceDocs);
        const status = await m.restoreVaultLocationWithin(3000);
        startExternalChanges(m);
        return status;
      }),
  }),
  new Promise((r) => setTimeout(r, 4000)),
]);
// The Dropbox / Google sign-in of the encrypted sync returns here (plan 3.5).
if (location.pathname.startsWith("/oauth/")) void import("./sync/e2ee/ui/launch").then((m) => m.oauthReturn(Promise.all([secretsReady, vaultReady])));
void Promise.all([initLocale(), secretsReady, vaultReady])
  .then(([applied]) => {
    // initLocale falls back to English when the saved locale's chunk can't
    // load; the store was already rehydrated with the saved locale, and
    // App applies the store's locale on mount — sync it so that doesn't
    // undo the fallback (English strings under an RTL `lang`).
    adoptBootLocale(applied);
  })
  .finally(renderApp);

function renderApp() {
ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary fallback={
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "100vh", background: "#0c0f17", color: "#e8e8e8",
          fontFamily: "Inter, system-ui, sans-serif", flexDirection: "column", gap: 16,
        }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>{t("boot.crashTitle")}</h1>
          <p style={{ fontSize: 14, opacity: 0.7, margin: 0 }}>{t("boot.crashBody")}</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px", border: "1px solid #7c5cff", borderRadius: 8,
              background: "transparent", color: "#7c5cff", cursor: "pointer",
            fontSize: 13, fontWeight: 500,
          }}
        >
          {t("boot.reload")}
        </button>
      </div>
    }>
      <Suspense fallback={
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "100vh", background: "#0c0f17", color: "#e8e8e8",
          fontFamily: "Inter, system-ui, sans-serif",
        }}>
          {t("boot.loading")}
        </div>
      }>
        <App />
      </Suspense>
    </ErrorBoundary>
    <UpdateBanner />
    <Suspense fallback={null}>
      <VaultFolderBanner />
    </Suspense>
    <ToastContainer />
  </React.StrictMode>,
);
}
