/**
 * AiSettingsPanel — one place for everything the local agents need
 * (MASTER_PLAN v2, D2): the AI policy, the preferred executor with live
 * availability, the Ollama server and model, the in-browser model and the
 * device it runs on, the grammar and research endpoints, the personal style
 * profile, and the recent agent runs. The model manager (plan 5.7) adds the
 * AI mode (economy / balanced / quality → the local model tier of the next
 * run), Ollama downloads with progress, and the storage the in-browser
 * models use, with clearing.
 *
 * Every field writes the same localStorage keys the runtime already reads,
 * so nothing here is a second source of truth.
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Cpu, X } from "lucide-react";
import { t } from "../i18n";
import { ollamaLicenceNotice } from "../ai/modelCatalog";
import { getSecret } from "../lib/secretStore";
import { RESEARCH_SERVICE_TOKEN } from "../research/client";
import type { AgentRun, ExecutorId } from "../agents/types";
import type { AiPolicy } from "../ai/policy";
import type { Hardware } from "../ai/modelManager";
import type { AiMode } from "../ai/aiMode";
import type { PullProgress } from "../ai/ollamaPull";
import type { ModelCacheKind, StorageEstimateResult } from "../ai/modelStorage";
import { EmptyState } from "./EmptyState";
import { uiConfirm } from "./PromptDialog";
import { HelpButton } from "./HelpButton";
import "./aiSettingsPanelStrings";
import { explainError } from "../lib/userError";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Rendered as a tab of the settings screen: no backdrop, no own close. */
  embedded?: boolean;
}

type RunnerId = Exclude<ExecutorId, "transformers">;

// Where models download from (plan W4.14): its strings travel with it.
const ModelSourcesSection = lazy(() => import("./ModelSourcesSection").then((m) => ({ default: m.ModelSourcesSection })));
type Status = { available: boolean; detail?: string } | "checking";

const box: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: 8,
  background: "hsl(var(--bg-subtle))",
  border: "1px solid hsl(var(--border))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const caption: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--fg-muted))" };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const input: React.CSSProperties = { flex: 1, minWidth: 0, padding: "4px 8px", fontSize: 13 };
const ghost: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };

function ls(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function setLs(key: string, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(key, value.trim());
    else localStorage.removeItem(key);
  } catch {
    /* why: storage denied */
  }
}

const EXECUTORS: RunnerId[] = ["ollama", "webllm", "chat"];
const MODES: AiMode[] = ["economy", "balanced", "quality"];
const GAP_LABEL = { "firefox-linux": "Firefox · Linux", android: "Android" } as const;

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function AiSettingsPanel({ open, onClose, embedded = false }: Props) {
  const [policy, setPolicyState] = useState<AiPolicy>("local-only");
  const [pref, setPref] = useState<ExecutorId | "auto">("auto");
  const [status, setStatus] = useState<Record<RunnerId, Status>>({ ollama: "checking", webllm: "checking", chat: "checking" });
  const [ollamaUrl, setOllamaUrl] = useState("");
  // The address the runtime uses; a download waits until an edit is saved.
  const [savedOllamaUrl, setSavedOllamaUrl] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [hw, setHw] = useState<Hardware | null>(null);
  const [budget, setBudget] = useState(0);
  const [webModel, setWebModel] = useState("");
  const [catalog, setCatalog] = useState<Array<{ id: string; label: string; vram: number }>>([]);
  const [grammarUrl, setGrammarUrl] = useState("");
  const [researchUrl, setResearchUrl] = useState("");
  const [researchToken, setResearchToken] = useState("");
  /** The token as loaded: an unchanged token isn't moved to a new endpoint. */
  const loadedToken = useRef("");
  const [endpointError, setEndpointError] = useState("");
  const [styleOn, setStyleOn] = useState(false);
  const [redactOn, setRedactOn] = useState(true);
  const [redactPreview, setRedactPreview] = useState(false);
  const [hasStyle, setHasStyle] = useState(false);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [saved, setSaved] = useState(false);
  const [mode, setMode] = useState<AiMode>("balanced");
  const [gap, setGap] = useState<keyof typeof GAP_LABEL | null>(null);
  const [pullName, setPullName] = useState("");
  const [pull, setPull] = useState<{ model: string; progress: PullProgress | null } | null>(null);
  const [pullMsg, setPullMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pullAbort = useRef<AbortController | null>(null);
  // undefined = still asking; null = the browser can't tell.
  const [storage, setStorage] = useState<StorageEstimateResult | null | undefined>(undefined);

  // The availability probes are slow (network); a panel closed meanwhile
  // must not receive their results (React warns, and test environments
  // that are already torn down throw "window is not defined").
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pullAbort.current?.abort();
    };
  }, []);

  const refreshStorage = useCallback(async () => {
    const { storageEstimate } = await import("../ai/modelStorage");
    const s = await storageEstimate();
    if (mounted.current) setStorage(s);
  }, []);

  const refreshStatus = useCallback(async () => {
    const { getExecutor } = await import("../agents/executors");
    if (!mounted.current) return;
    setStatus({ ollama: "checking", webllm: "checking", chat: "checking" });
    const next = {} as Record<RunnerId, Status>;
    await Promise.all(
      EXECUTORS.map(async (id) => {
        try {
          const a = (await getExecutor(id)?.available()) ?? { available: false, reason: "not-registered" };
          next[id] = { available: a.available, detail: a.available ? undefined : a.detail ?? a.reason };
        } catch (e) {
          next[id] = { available: false, detail: (e as Error)?.message };
        }
      }),
    );
    if (!mounted.current) return;
    setStatus(next);
    try {
      const { refreshOllama } = await import("../agents/executors/ollama");
      const models = (await refreshOllama(true)).models.map((m) => m.name);
      if (mounted.current) setInstalled(models);
    } catch {
      if (mounted.current) setInstalled(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const [{ getAiPolicy }, { preferredExecutor }, mm, style, trace, { getBaseUrl, getOllamaConfigModel }, { grammarEndpoint }, { getAiMode }, { webGpuGap }] = await Promise.all([
        import("../ai/policy"),
        import("../agents/executors"),
        import("../ai/modelManager"),
        import("../ai/styleProfiles"),
        import("../agents/trace"),
        import("../ai/ollamaProvider"),
        import("../ai/grammar"),
        import("../ai/aiMode"),
        import("../ai/webGpuGap"),
      ]);
      if (!alive) return;
      setPolicyState(getAiPolicy());
      setMode(getAiMode());
      setPref(preferredExecutor() ?? "auto");
      setOllamaUrl(getBaseUrl());
      setSavedOllamaUrl(getBaseUrl());
      setOllamaModel(ls("lumen.ollama.model") || getOllamaConfigModel());
      setGrammarUrl(ls("lumen.grammar.endpoint") || grammarEndpoint());
      setResearchUrl(ls("lumen.research.endpoint"));
      const saved = getSecret(RESEARCH_SERVICE_TOKEN) ?? "";
      loadedToken.current = saved;
      setResearchToken(saved);
      setHasStyle(!!style.getStyleProfile());
      setStyleOn(style.styleProfileActive());
      const red = await import("../ai/piiRedactor");
      if (!alive) return;
      setRedactOn(red.redactionEnabled());
      setRedactPreview(red.previewEnabled());
      setWebModel(mm.selectedWebLlmModel() ?? "");
      await trace.loadTrace();
      // listRuns() is newest first: the first ten are the ten latest.
      if (alive) setRuns(trace.listRuns().slice(0, 10));
      const h = await mm.detectHardware();
      if (!alive) return;
      setHw(h);
      setGap(webGpuGap(h));
      setBudget(mm.vramBudgetMB(h));
      setCatalog(
        mm.WEBLLM_CATALOG.map((e) => ({ id: mm.webLlmModelId(e, h.f16), label: e.licence ? `${e.label} — ${e.licence}` : e.label, vram: h.f16 ? e.vramMB.f16 : e.vramMB.f32 })),
      );
    })();
    void refreshStatus();
    void refreshStorage();
    return () => {
      alive = false;
    };
  }, [open, refreshStatus, refreshStorage]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  // Embedded in the settings screen, that screen traps focus and handles Escape.
  useFocusTrap(trapRef, { active: open && !embedded, onEscape: onClose });

  if (!open) return null;

  const flash = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const changePolicy = async (p: AiPolicy) => {
    const { setAiPolicy } = await import("../ai/policy");
    setAiPolicy(p);
    setPolicyState(p);
    flash();
    void refreshStatus();
  };

  const changePref = async (p: ExecutorId | "auto") => {
    const { setPreferredExecutor } = await import("../agents/executors");
    setPreferredExecutor(p === "auto" ? null : p);
    setPref(p);
    flash();
    // Choosing the in-browser model is the opt-in it needs under local-first; show the new state.
    void refreshStatus();
  };

  const saveOllama = async () => {
    const lic = ollamaModel.trim() && ollamaModel.trim() !== ls("lumen.ollama.model") ? ollamaLicenceNotice(ollamaModel.trim()) : null;
    if (lic) {
      const { uiConfirm } = await import("./PromptDialog");
      const ok = await uiConfirm({
        title: t("ai.localModels.licenceTitle"),
        message: t("ai.localModels.licenceBody", { model: ollamaModel.trim(), licence: lic.name }),
        okLabel: t("ai.localModels.licenceOk"),
      });
      if (!ok) return;
    }
    setLs("lumen.ollama.baseUrl", ollamaUrl);
    const { getBaseUrl } = await import("../ai/ollamaProvider");
    setSavedOllamaUrl(ollamaUrl.trim() || getBaseUrl());
    setLs("lumen.ollama.model", ollamaModel);
    flash();
    void refreshStatus();
  };

  const changeMode = async (m: AiMode) => {
    const { setAiMode } = await import("../ai/aiMode");
    setAiMode(m);
    setMode(m);
    flash();
  };

  // An address edited but not saved: the pull would go to the old server.
  const urlUnsaved = ollamaUrl.trim().replace(/\/+$/, "") !== savedOllamaUrl.replace(/\/+$/, "");

  const startPull = async () => {
    const model = pullName.trim();
    // Locked synchronously: a double click (or Enter, then a click) while
    // the modules or the licence prompt are pending must not start a
    // second download.
    if (!model || pullAbort.current || urlUnsaved) return;
    const ctrl = new AbortController();
    pullAbort.current = ctrl;
    // A custom-licence or non-commercial model is named and confirmed before
    // its weights are downloaded, as before choosing it (plan 1.7).
    const lic = ollamaLicenceNotice(model);
    if (lic) {
      const { uiConfirm } = await import("./PromptDialog");
      const ok = await uiConfirm({
        title: t("ai.localModels.licenceTitle"),
        message: t("ai.localModels.licenceBody", { model, licence: lic.name }),
        okLabel: t("ai.localModels.licenceOk"),
      });
      if (!ok) {
        if (pullAbort.current === ctrl) pullAbort.current = null;
        return;
      }
    }
    setPullMsg(null);
    setPull({ model, progress: null });
    try {
      const [{ pullOllamaModel }, { getBaseUrl }] = await Promise.all([import("../ai/ollamaPull"), import("../ai/ollamaProvider")]);
      await pullOllamaModel(getBaseUrl(), model, {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (mounted.current) setPull({ model, progress: p });
        },
      });
      if (!mounted.current) return;
      setPullMsg({ ok: true, text: t("ai.settings.ollama.pulled", { model }) });
      setPullName("");
      void refreshStatus();
    } catch (e) {
      if (!mounted.current || (e as Error)?.name === "AbortError") return;
      setPullMsg({ ok: false, text: t("ai.settings.ollama.pullFailed", { error: explainError(e) }) });
    } finally {
      if (pullAbort.current === ctrl) pullAbort.current = null;
      if (mounted.current) setPull(null);
    }
  };

  const cancelPull = () => pullAbort.current?.abort();

  const clearCaches = async (kind: ModelCacheKind) => {
    const { clearModelCaches } = await import("../ai/modelStorage");
    await clearModelCaches(kind);
    // The usage line shows the result.
    if (mounted.current) void refreshStorage();
  };

  const changeWebModel = async (id: string) => {
    const { setWebLlmModel } = await import("../ai/modelManager");
    setWebLlmModel(id || null);
    setWebModel(id);
    flash();
  };

  const saveEndpoints = async () => {
    // An address the browser can't reach (bad URL, blocked by the CSP) is
    // not stored: it would hide a working build-time endpoint.
    const { usableResearchEndpoint, saveResearchToken } = await import("../research/client");
    const research = researchUrl.trim() ? usableResearchEndpoint(researchUrl) : "";
    if (research === null) {
      setEndpointError(t("research.endpointInvalid", { url: researchUrl.trim() }));
      return;
    }
    setEndpointError("");
    setLs("lumen.grammar.endpoint", grammarUrl);
    setLs("lumen.research.endpoint", research);
    // The research service's shared token (A8), bound to the endpoint in use.
    const kept = saveResearchToken(researchToken, researchToken !== loadedToken.current);
    loadedToken.current = kept;
    setResearchToken(kept);
    const { clearGrammarCache } = await import("../ai/grammar");
    clearGrammarCache();
    flash();
  };

  const toggleStyle = async (on: boolean) => {
    const { setStyleProfileActive } = await import("../ai/styleProfiles");
    setStyleProfileActive(on);
    setStyleOn(on);
    flash();
  };

  const toggleRedact = async (on: boolean) => {
    const { setRedactionEnabled } = await import("../ai/piiRedactor");
    setRedactionEnabled(on);
    setRedactOn(on);
    flash();
  };

  const toggleRedactPreview = async (on: boolean) => {
    const { setPreviewEnabled } = await import("../ai/piiRedactor");
    setPreviewEnabled(on);
    setRedactPreview(on);
    flash();
  };

  const clearRuns = async () => {
    if (!(await uiConfirm({ message: t("ai.trace.clearConfirm", { n: runs.length }) }))) return;
    const { clearTrace } = await import("../agents/trace");
    await clearTrace();
    setRuns([]);
  };

  const runCommand = (id: string) => {
    onClose();
    window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id } }));
  };

  const statusText = (s: Status) =>
    s === "checking" ? t("ai.settings.checking") : s.available ? t("ai.settings.available") : t("ai.settings.unavailable", { reason: s.detail ?? "" });

  return (
    <div
      className={embedded ? undefined : "cmd-palette-backdrop"}
      onClick={embedded ? undefined : onClose}
      ref={trapRef}
      role={embedded ? "region" : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-label={t("ai.settings.title")}
    >
      <div
        className={embedded ? undefined : "cmd-palette"}
        onClick={(e) => e.stopPropagation()}
        style={embedded ? { display: "flex", flexDirection: "column" } : { maxWidth: 600, padding: 0, display: "flex", flexDirection: "column", maxHeight: "85vh" }}
      >
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Cpu size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("ai.settings.title")}</h2>
          {saved && <span style={muted}>{t("ai.settings.saved")}</span>}
          {!embedded && (
            <button type="button" style={ghost} onClick={onClose} aria-label={t("ai.settings.close")}>
              <X size={16} />
            </button>
          )}
          <HelpButton topic="ai/local-agents#ai-settings" />
        </header>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, fontSize: 13, lineHeight: 1.5, overflowY: "auto" }}>
          <section style={box} aria-labelledby="ai-set-policy">
            <div id="ai-set-policy" style={caption}>{t("ai.policy.title")}</div>
            {(["local-only", "local-first", "cloud"] as AiPolicy[]).map((p) => (
              <label key={p} style={row}>
                <input type="radio" name="ai-policy" checked={policy === p} onChange={() => void changePolicy(p)} />
                <span>{t(p === "local-only" ? "ai.policy.localOnly" : p === "local-first" ? "ai.policy.localFirst" : "ai.policy.cloud")}</span>
              </label>
            ))}
          </section>

          {policy !== "local-only" && (
            <section style={box} aria-labelledby="ai-set-redact" data-testid="ai-set-redact">
              <div id="ai-set-redact" style={caption}>{t("pii.settings.title")}</div>
              <label style={row}>
                <input type="checkbox" checked={redactOn} onChange={(e) => void toggleRedact(e.target.checked)} />
                <span>{t("pii.settings.redact")}</span>
              </label>
              <label style={row}>
                <input type="checkbox" checked={redactPreview} disabled={!redactOn} onChange={(e) => void toggleRedactPreview(e.target.checked)} />
                <span>{t("pii.settings.preview")}</span>
              </label>
              <div style={muted}>{t("pii.settings.hint")}</div>
            </section>
          )}

          <section style={box} aria-labelledby="ai-set-exec">
            <div id="ai-set-exec" style={caption}>{t("ai.settings.executor")}</div>
            <label style={row}>
              <input type="radio" name="ai-exec" checked={pref === "auto"} onChange={() => void changePref("auto")} />
              <span>{t("ai.settings.executor.auto")}</span>
            </label>
            {EXECUTORS.map((id) => (
              <label key={id} style={row}>
                <input type="radio" name="ai-exec" checked={pref === id} onChange={() => void changePref(id)} />
                <span style={{ minWidth: 150 }}>{t(`ai.settings.executor.${id}`)}</span>
                <span style={muted} data-testid={`exec-status-${id}`}>{statusText(status[id])}</span>
              </label>
            ))}
            <div style={row}>
              <button type="button" style={ghost} onClick={() => void refreshStatus()}>{t("ai.settings.recheck")}</button>
            </div>
          </section>

          <section style={box} aria-labelledby="ai-set-mode">
            <div id="ai-set-mode" style={caption}>{t("ai.mode.title")}</div>
            {MODES.map((m) => (
              <label key={m} style={row}>
                <input type="radio" name="ai-mode" checked={mode === m} onChange={() => void changeMode(m)} />
                <span>{t(`ai.mode.${m}`)}</span>
              </label>
            ))}
          </section>

          <section style={box} aria-labelledby="ai-set-ollama">
            <div id="ai-set-ollama" style={caption}>Ollama</div>
            <label style={row}>
              <span style={{ minWidth: 90 }}>{t("ai.settings.ollama.url")}</span>
              <input style={input} value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} placeholder="http://localhost:11434" />
            </label>
            <label style={row}>
              <span style={{ minWidth: 90 }}>{t("ai.settings.ollama.model")}</span>
              <input style={input} value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} placeholder="qwen2.5:7b" list="ai-set-ollama-models" />
              <datalist id="ai-set-ollama-models">
                {(installed ?? []).map((m) => {
                  // A custom-licence or non-commercial model is named with its licence (plan 1.7).
                  const lic = ollamaLicenceNotice(m);
                  return <option key={m} value={m} label={lic ? `${m} · ${lic.name}` : undefined} />;
                })}
              </datalist>
            </label>
            {installed !== null && installed.length === 0 ? (
              <EmptyState
                style={{ padding: 0 }}
                message={t("ai.settings.ollama.none")}
                action={{ label: t("ai.settings.ollama.copyPull"), onClick: () => void navigator.clipboard?.writeText("ollama pull qwen2.5:7b").catch(() => undefined) }}
              />
            ) : (
              <div style={muted}>{installed === null ? t("ai.settings.ollama.unreachable") : t("ai.settings.ollama.installed", { models: installed.join(", ") })}</div>
            )}
            <div style={row}>
              <button type="button" style={primary} onClick={() => void saveOllama()}>{t("ai.settings.save")}</button>
            </div>
            <div style={row}>
              <input
                style={input}
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void startPull();
                }}
                placeholder="qwen3:4b"
                aria-label={t("ai.settings.ollama.pull")}
                disabled={!!pull}
              />
              {pull ? (
                <button type="button" style={ghost} onClick={cancelPull}>{t("dialog.cancel")}</button>
              ) : (
                <button type="button" style={ghost} onClick={() => void startPull()} disabled={!pullName.trim() || urlUnsaved}>{t("ai.settings.ollama.pull")}</button>
              )}
            </div>
            {pull && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <progress
                  data-testid="ollama-pull-progress"
                  max={1}
                  value={pull.progress?.fraction ?? undefined}
                  aria-label={pull.model}
                  style={{ width: "100%" }}
                />
                <div style={muted} data-testid="ollama-pull-status" aria-live="polite">
                  {t("ai.settings.ollama.pulling", {
                    model: pull.model,
                    status:
                      pull.progress && pull.progress.fraction !== null && pull.progress.total > 0
                        ? `${Math.round(pull.progress.fraction * 100)}% · ${bytes(pull.progress.completed)} / ${bytes(pull.progress.total)}`
                        : pull.progress?.status || "…",
                  })}
                </div>
              </div>
            )}
            {pullMsg && (
              <div role={pullMsg.ok ? "status" : "alert"} style={pullMsg.ok ? muted : { fontSize: 12, color: "hsl(var(--danger, 0 72% 51%))" }}>
                {pullMsg.text}
              </div>
            )}
          </section>

          <section style={box} aria-labelledby="ai-set-web">
            <div id="ai-set-web" style={caption}>{t("ai.settings.browser")}</div>
            <div style={muted} data-testid="hw-card">
              {hw === null
                ? t("ai.settings.checking")
                : hw.webgpu
                  ? t("ai.settings.hw.ok", { budget: String(budget), f16: hw.f16 ? "f16" : "f32", cores: String(hw.cores ?? "?"), memory: String(hw.deviceMemoryGB ?? "?") })
                  : // empty-action: the Ollama section above (the message names it)
                    t("ai.settings.hw.none", { reason: gap ? GAP_LABEL[gap] : hw.reason ?? "" })}
            </div>
            {gap && <div style={muted} data-testid="hw-gap">{t("ai.settings.hw.wasm")}</div>}
            {hw?.webgpu && (
              <label style={row}>
                <span style={{ minWidth: 90 }}>{t("ai.settings.browser.model")}</span>
                <select style={input} value={webModel} onChange={(e) => void changeWebModel(e.target.value)}>
                  <option value="">{t("ai.settings.browser.recommended")}</option>
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.vram > budget}>
                      {c.label} · {(c.vram / 1024).toFixed(1)} GB{c.vram > budget ? ` · ${t("ai.settings.browser.tooBig")}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div style={row}>
              <button type="button" style={ghost} onClick={() => runCommand("ai.localModels")}>{t("cmd.ai.localModels")}</button>
            </div>
          </section>

          <section style={box} aria-labelledby="ai-set-storage">
            <div id="ai-set-storage" style={caption}>{t("ai.settings.storage")}</div>
            {storage !== null && (
              <div style={muted} data-testid="storage-usage">
                {storage === undefined ? t("ai.settings.checking") : t("ai.settings.storage.usage", { usage: bytes(storage.usage), quota: bytes(storage.quota) })}
              </div>
            )}
            <div style={row}>
              <button type="button" style={ghost} onClick={() => void clearCaches("webllm")}>{t("ai.settings.storage.clearWebllm")}</button>
              <button type="button" style={ghost} onClick={() => void clearCaches("transformers")}>{t("ai.settings.storage.clearWasm")}</button>
            </div>
          </section>

          <section style={box} aria-labelledby="ai-set-sources" data-testid="ai-set-sources">
            <Suspense fallback={null}>
              <ModelSourcesSection captionStyle={caption} />
            </Suspense>
          </section>

          <section style={box} aria-labelledby="ai-set-endpoints">
            <div id="ai-set-endpoints" style={caption}>{t("ai.settings.endpoints")}</div>
            <label style={row}>
              <span style={{ minWidth: 90 }}>{t("ai.settings.grammar")}</span>
              <input style={input} value={grammarUrl} onChange={(e) => setGrammarUrl(e.target.value)} placeholder="http://localhost:8010/v2/check" />
            </label>
            <label style={row}>
              <span style={{ minWidth: 90 }}>{t("ai.settings.research")}</span>
              <input style={input} value={researchUrl} onChange={(e) => setResearchUrl(e.target.value)} placeholder="http://localhost:8787" />
            </label>
            <label style={row}>
              <span style={{ minWidth: 90 }}>{t("ai.settings.researchToken")}</span>
              <input
                style={input}
                type="password"
                autoComplete="off"
                value={researchToken}
                onChange={(e) => setResearchToken(e.target.value)}
                placeholder={t("ai.settings.researchToken.placeholder")}
              />
            </label>
            <div style={muted}>{t("ai.settings.endpoints.hint")}</div>
            {endpointError && (
              <div role="alert" style={{ fontSize: 12, color: "hsl(var(--danger, 0 72% 51%))" }}>
                {endpointError}
              </div>
            )}
            <div style={row}>
              <button type="button" style={primary} onClick={() => void saveEndpoints()}>{t("ai.settings.save")}</button>
            </div>
          </section>

          <section style={box} aria-labelledby="ai-set-style">
            <div id="ai-set-style" style={caption}>{t("ai.settings.style")}</div>
            {hasStyle ? (
              <label style={row}>
                <input type="checkbox" checked={styleOn} onChange={(e) => void toggleStyle(e.target.checked)} />
                <span>{t("ai.settings.style.use")}</span>
              </label>
            ) : (
              // empty-action: the "Build style profile" button right below (runCommand("ai.styleProfile")).
              <div style={muted}>{t("ai.settings.style.none")}</div>
            )}
            <div style={row}>
              <button type="button" style={ghost} onClick={() => runCommand("ai.styleProfile")}>{t("cmd.ai.styleProfile")}</button>
            </div>
          </section>

          <section style={box} aria-labelledby="ai-set-trace">
            <div id="ai-set-trace" style={caption}>{t("ai.settings.trace")}</div>
            {runs.length === 0 ? (
              <EmptyState style={{ padding: 0 }} message={t("ai.trace.empty")} action={{ label: t("ai.trace.testSetup"), onClick: () => runCommand("ai.doctor") }} />
            ) : (
              <ul style={{ margin: 0, paddingInlineStart: 18, display: "flex", flexDirection: "column", gap: 2 }}>
                {runs.map((r) => (
                  <li key={r.id} style={{ fontSize: 12 }}>
                    <strong>{r.agentId}</strong> · {r.status} · {r.executor ?? "—"}
                    {r.model ? ` (${r.model})` : ""} · {Math.max(0, r.endedAt - r.startedAt)} ms
                    {r.error ? <span style={muted}> — {r.error}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <div style={row}>
              <button type="button" style={ghost} onClick={() => runCommand("ai.trace")}>{t("cmd.ai.trace")}</button>
              {runs.length > 0 && (
                <button type="button" style={ghost} onClick={() => void clearRuns()}>{t("ai.settings.trace.clear")}</button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
