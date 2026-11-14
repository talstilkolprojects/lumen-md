// Must stay the first import: Trusted Types policies before any DOM sink.
import "./lib/trustedTypesInit";
import "./fonts";
import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UpdateBanner } from "./ui/UpdateBanner";
import { setVaultBackend, createDirectoryHandleBackend } from "./storage/vault";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { showAiToast } from "./ui/AiToast";
import { ToastContainer } from "./components/Toast";
import { initTelemetry } from "./lib/telemetry";
import { initAuth } from "./auth/useAuth";
import { reportWebVitals } from "./lib/webVitals";
import { log } from "./lib/logger";
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
// Esc cancels any running AI request (T55).
installAiEscape((n) => showAiToast(t("toast.aiCancelled", { count: n }), "info"));
initTelemetry();
void initAuth();
startAutoBackup();
startVaultSnapshots();
// The vault lives in OPFS/IndexedDB; without this the browser may evict it.
void requestPersistentStorage();

// Core Web Vitals — opt-out gates inside; sink writes to the structured
// log so Sentry (when configured) picks them up alongside other events.
// No-op in browsers without PerformanceObserver.
reportWebVitals((sample) => {
  log.info("[web-vitals]", sample);
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
const vaultReady = Promise.race([
  import("./storage/vault/location").then(async (m) => {
    const { detachWorkspaceDocs } = await import("./store/vaultDocs");
    m.setOnVaultReplaced(detachWorkspaceDocs);
    const status = await m.restoreVaultLocationWithin(3000);
    // Changes made outside Lumen reach the open tabs (plan 4.4) — started
    // once the vault is known, and the open notes are checked against the
    // disk again whenever another vault opens (reconnect, late restore, move).
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
    return status;
  }),
  new Promise((r) => setTimeout(r, 4000)),
]).catch((err) => log.warn("vault location unavailable", err));
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
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, opacity: 0.7, margin: 0 }}>Lumen encountered an unexpected error.</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px", border: "1px solid #7c5cff", borderRadius: 8,
              background: "transparent", color: "#7c5cff", cursor: "pointer",
            fontSize: 13, fontWeight: 500,
          }}
        >
          Reload Lumen
        </button>
      </div>
    }>
      <Suspense fallback={
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "100vh", background: "#0c0f17", color: "#e8e8e8",
          fontFamily: "Inter, system-ui, sans-serif",
        }}>
          Loading Lumen…
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
