/**
 * The shell's side effects that own no App state (W6.25: moved out of
 * App.tsx unchanged): reading options, CSS snippets, the launch update
 * check, what's new, entitlements, theme, locale, the plugin API and the
 * e2e test surface, the web clipper bridge, a note shared from iOS, the
 * history quota warnings and the model critic.
 */
import { useEffect } from "react";
import { wirePluginAPI, registerPlugin, unregisterPlugin, wordCountPlugin } from "../plugins/pluginSystem";
import { showAiToast } from "../ui/AiToast";
import { ledgerEntries } from "../ai/privacyLedger";
import { useEntitlement, watchAuthForEntitlements } from "../billing/useEntitlement";
import { useAppStore, applyTheme } from "../store/useStore";
import { applyLocale, t } from "../i18n";
import { onHistoryQuota, onQuotaWarning } from "../storage/history";
import { explainError } from "../lib/userError";
import { openNewDoc } from "../commands/useCommands";

export function useAppBootEffects(): void {
  // Reading options (plan W3.5): the open note's face, size and spacing.
  // The module (and any face) loads only once the person has set one.
  const readingPath = useAppStore((s) => s.doc.workspaceName ?? null);
  useEffect(() => {
    let live = true;
    const apply = () => {
      let stored = false;
      try {
        stored = localStorage.getItem("lumen-reading") !== null;
      } catch {
        /* why: no storage: nothing set */
      }
      if (!stored) return;
      void import("../reading/settings").then((m) => {
        if (live) void m.applyReading(m.effectiveReading(readingPath));
      });
    };
    apply();
    window.addEventListener("lumen-reading-changed", apply);
    return () => {
      live = false;
      window.removeEventListener("lumen-reading-changed", apply);
    };
  }, [readingPath]);

  const enabledSnippets = useAppStore((s) => s.enabledSnippets);
  // CSS snippets from the vault (plan W1.21): sanitized, applied, kept in step with the files.
  useEffect(() => {
    if (!enabledSnippets.length && !document.querySelector("style[data-lumen-snippet]")) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void Promise.all([import("../theme/snippets"), import("../storage/workspaceEvents")]).then(([m, ev]) => {
      if (cancelled) return;
      const run = () => void m.refreshSnippets(useAppStore.getState().enabledSnippets).catch(() => undefined);
      run();
      off = ev.onWorkspaceChanged(run, { debounceMs: 300 });
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [enabledSnippets]);

  // Plan 14.4: the beta flag update.checkOnLaunch — once a day, desktop only,
  // never in local-only; says something only when there is an update.
  useEffect(() => {
    const timer = setTimeout(() => {
      void import("../desktop/updates")
        .then((m) => m.launchUpdateCheck())
        .then((r) => {
          if (r?.state === "available") showAiToast(t("update.launch.available", { version: r.version }), "info");
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Plan 14.6: after an update, that version's notes once (when the app is idle; nothing on a fresh install).
  useEffect(() => {
    const run = () => void import("../whatsNew/check").then((m) => m.checkWhatsNew()).catch(() => undefined);
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(run, { timeout: 4000 });
    else setTimeout(run, 2000);
  }, []);

  useEffect(() => {
    void useEntitlement.getState().refresh();
    // Re-fetch when the user signs in/out or the session restore finishes.
    return watchAuthForEntitlements();
  }, []);

  // Apply theme on mount
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Plugin system init
  useEffect(() => {
    wirePluginAPI({
      getContent: () => useAppStore.getState().doc.content,
      setContent: (s: string) => useAppStore.getState().setContent(s),
      getFileName: () => useAppStore.getState().doc.name,
      showToast: (msg: string) => showAiToast(msg, "info"),
    });
    registerPlugin(wordCountPlugin);
    // Expose a tiny test surface on window.__lumen for e2e specs. This
    // lets the prod-build paste-html spec call htmlToMarkdown without
    // importing /src/* at runtime (which only works against the dev
    // server). The surface is intentionally minimal — only utilities
    // the test suite needs. `ocr` is the app's own OCR path (plan 7.5:
    // e2e/ocr-cer.spec.ts measures its CER on the production build); the
    // module loads on the first call only.
    (window as unknown as { __lumen?: unknown }).__lumen = {
      // Async: the converters load on first use (startup budget); page.evaluate awaits it.
      htmlToMarkdown: (html: string) => import("../storage/fileFormats").then((m) => m.htmlToMarkdown(html)),
      // `agentReview` (plan 5.11 e2e) is added by agents/reviewBridge once it
      // loads, in development and tests only (plan W1.31).
      // The vault index, for e2e/perf-vault.spec.ts (a lazy chunk).
      vaultIndex: () => import("../storage/vaultIndexProbe"),
      ocr: (image: Blob) => import("../ai/ocr").then((m) => m.ocrImage(image)),
      // live-exec spec: the run_python agent tool, called as the runtime
      // calls it (read scope), and the privacy ledger it reports to.
      runPython: async (args: { code: string; inputs?: Record<string, unknown>; timeoutMs?: number }) =>
        (await import("../agents/tools/python")).runPythonTool.run(args, { grants: new Set(["read" as const]) }),
      ledger: () => ledgerEntries(),
      // W2.23 — the print document as HTML, for the print golden tests.
      buildPrintHtml: (md: string, name: string) => import("../ui/PrintExport").then((m) => m.buildPrintHtml(md, name)),
    };
    return () => {
      unregisterPlugin(wordCountPlugin.id);
      delete (window as unknown as { __lumen?: unknown }).__lumen;
    };
  }, []);

  // Apply locale (sets <html lang dir>) on mount and on change.
  const locale = useAppStore((s) => s.locale);
  useEffect(() => {
    applyLocale(locale);
  }, [locale]);

  // Web clipper v2 (plan 4.15.2): clips from the extension's bridge
  // (postMessage), the desktop deep link, or `#clip=` in the address. The
  // modules load only when a clip arrives; the listener itself is tiny.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    const save = (p: import("../research/clipV2").ClipPayload) =>
      void import("../commands/useCommands").then(({ saveClipV2 }) => saveClipV2(p)).catch((e) => showAiToast(t("clip.failed", { message: explainError(e) }), "error"));
    void import("../research/clipBridge").then(({ startClipBridge }) => {
      if (!cancelled) stop = startClipBridge(save);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Check for a shared note from the iOS Share Extension.
  useEffect(() => {
    const pending = (window as unknown as Record<string, unknown>).__pendingSharedNote;
    if (typeof pending === "string" && pending.length > 0) {
      // Clear the pending note so we don't process it again.
      delete (window as unknown as Record<string, unknown>).__pendingSharedNote;
      openNewDoc("Shared Note", pending, true);
      showAiToast(t("toast.openedSharedNoteFromIos"), "info");
    }
  }, []);

  // History quota: the store pruned its oldest quarter and still could not write.
  useEffect(() => onHistoryQuota(() => showAiToast(t("doc.history.quota"), "error")), []);
  // Plan 3.2: warn before it comes to that — past 80 % of the browser's quota.
  useEffect(
    () => onQuotaWarning(({ usage, quota }) => showAiToast(t("doc.history.quotaWarn", { percent: String(Math.round((usage / quota) * 100)) }), "error")),
    [],
  );

  // Stage 2 of the improvement agent (a small local model proposes suggestions).
  useEffect(() => {
    void import("../agents/modelCritic").then((m) => m.installModelCritic());
  }, []);
}
