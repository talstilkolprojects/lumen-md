import { countWords } from "../text/hebrew";
import React, { useMemo, useState, useCallback, useSyncExternalStore } from "react";
import { Sparkles, ShieldCheck, SpellCheck, FileDiff, Activity, BarChart3, CloudCog, CloudOff, AlertCircle } from "lucide-react";
import type { CollabPeer } from "../collab/yjs";
import { t, getLocale } from "../i18n";
import { useAppStore } from "../store/useStore";
import { getTelemetryOptOut, setTelemetryOptOut } from "../lib/telemetry";
import type { ConfigHealthReport } from "../lib/configHealth";
import { subscribeSyncStatus } from "../sync/syncStatus";
import { secretStoreMode, subscribeSecretStoreMode } from "../lib/secretStore";
import { parseSuggestions, mayContainCriticMarkup } from "../editor/suggesting";

/** Number of CriticMarkup suggestions (cheap no-op for plain docs). */
function countCriticMarkup(text: string): number {
  return mayContainCriticMarkup(text) ? parseSuggestions(text).length : 0;
}

interface CollabInfo {
  roomName: string;
  peers: CollabPeer[];
  onLeave: () => void;
}

interface Props {
  text: string;
  /** doc dirty flag */
  dirty: boolean;
  /** Filename for display */
  filename: string;
  /** When in a collab session, shows peer dots and a leave action. */
  collab?: CollabInfo | null;
  configHealth?: ConfigHealthReport;
  onOpenRuntimeMetrics?: () => void;
}

export const StatusBar = React.memo(function StatusBar({
  text,
  dirty,
  filename,
  collab,
  configHealth,
  onOpenRuntimeMetrics,
}: Props) {
  const stats = useMemo(() => computeStats(text), [text]);
  const syncState = useSyncExternalStore(
    subscribeSyncStatus,
    () => "idle" as const,
    () => "idle" as const,
  );
  // No silent plain mode (plan 2.5): unencrypted secrets are always visible here.
  const secretsMode = useSyncExternalStore(subscribeSecretStoreMode, secretStoreMode, secretStoreMode);
  const aiKey = useAppStore((s) => s.aiKey);
  const useLocalAi = useAppStore((s) => s.useLocalAi);
  const grammarCheck = useAppStore((s) => s.grammarCheck);
  const toggleGrammarCheck = useAppStore((s) => s.toggleGrammarCheck);
  const suggestingMode = useAppStore((s) => s.suggestingMode);
  const toggleSuggestingMode = useAppStore((s) => s.toggleSuggestingMode);
  const suggestionCount = useMemo(() => countCriticMarkup(text), [text]);
  const [telemetryOff, setTelemetryOff] = useState(getTelemetryOptOut);
  const toggleTelemetry = useCallback(() => {
    const next = !telemetryOff;
    setTelemetryOptOut(next);
    setTelemetryOff(next);
  }, [telemetryOff]);
  const healthIssues = configHealth
    ? [
        ...configHealth.blocked.map((item) => ({ ...item, emoji: "⚠", color: "hsl(12 90% 58%)" })),
        ...configHealth.partial.map((item) => ({ ...item, emoji: "◌", color: "hsl(35 90% 60%)" })),
      ].slice(0, 2)
    : [];
  const healthColor = !configHealth
    ? "hsl(var(--fg-muted))"
    : configHealth.score >= 85
      ? "hsl(145 60% 45%)"
      : configHealth.score >= 65
        ? "hsl(35 90% 55%)"
        : "hsl(12 90% 58%)";
  return (
    <footer className="status-bar">
      <span className="sb-item" title="Document">
        {dirty ? "●" : "○"} {filename}
      </span>
      {syncState !== "idle" && (
        <span className="sb-item" title={`Sync: ${syncState}`} style={{ gap: 4 }}>
          {syncState === "syncing" && <CloudCog size={10} className="spin" />}
          {syncState === "error" && <AlertCircle size={10} style={{ color: "hsl(12 90% 58%)" }} />}
          {syncState === "offline" && <CloudOff size={10} style={{ color: "hsl(var(--fg-muted))" }} />}
          <span style={{ fontSize: 10, textTransform: "capitalize" }}>{syncState}</span>
        </span>
      )}
      {collab && (
        <span
          className="sb-item"
          title={`Collab room: ${collab.roomName}\n${collab.peers.length} peer(s)`}
          style={{ gap: 6 }}
        >
          <span className="sb-accent" style={{ fontWeight: 600 }}>{t("status.live")}</span>
          <span style={{ display: "inline-flex", gap: 3 }}>
            {collab.peers.slice(0, 5).map((p) => (
              <span
                key={p.clientId}
                title={`${p.user.name}${p.isSelf ? " (you)" : ""}`}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: p.user.color,
                  border: p.isSelf
                    ? "1px solid hsl(var(--fg))"
                    : "1px solid hsl(var(--border))",
                  display: "inline-block",
                }}
              />
            ))}
            {collab.peers.length > 5 && (
              <span style={{ marginLeft: 4 }}>+{collab.peers.length - 5}</span>
            )}
          </span>
          <button
            type="button"
            onClick={collab.onLeave}
            title="Leave collaboration"
            style={{
              marginLeft: 4,
              padding: "0 6px",
              fontSize: 10,
              border: "1px solid hsl(var(--border))",
              borderRadius: 3,
              background: "transparent",
              color: "hsl(var(--fg-muted))",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("status.leave")}
          </button>
        </span>
      )}
      <span className="sb-spacer" />
      {configHealth ? (
        <span
          className="sb-item"
          title={configHealth.items.map((item) => `${item.label}: ${item.details}`).join("\n")}
          style={{
            color: healthColor,
            fontWeight: 600,
            gap: 4,
          }}
        >
          <span>{`Health ${configHealth.score}%`}</span>
          {healthIssues.length > 0 && (
            <span style={{ color: "hsl(var(--fg-muted))", fontWeight: 400 }}>
              ·
              {healthIssues.map((item) => (
                <span key={item.key} title={item.details} style={{ marginLeft: 6, color: item.color }}>
                  {item.emoji} {item.label}
                </span>
              ))}
            </span>
          )}
        </span>
      ) : null}
      <span className="sb-item" title="Word count">
        {t("status.words", { n: stats.words.toLocaleString(getLocale()) })}
      </span>
      <span className="sb-item" title="Characters (without spaces)">
        {t("status.chars", { n: stats.chars.toLocaleString(getLocale()) })}
      </span>
      <span className="sb-item" title="Reading time at ~220 wpm">
        {t("status.reading", { n: stats.readingMin })}
      </span>
      <button
        type="button"
        className="sb-item"
        onClick={toggleSuggestingMode}
        title={
          suggestingMode
            ? t("status.suggesting.tooltip.on")
            : t("status.suggesting.tooltip.off")
        }
        data-testid="status-suggesting"
        aria-pressed={suggestingMode}
        style={{
          gap: 4,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
          color: suggestingMode ? "hsl(145 60% 45%)" : "hsl(var(--fg-muted))",
        }}
      >
        <FileDiff size={10} />
        <span style={{ fontSize: 10, fontWeight: suggestingMode ? 600 : 400 }}>
          {suggestingMode ? t("status.suggesting.on") : t("status.suggesting.off")}
          {suggestionCount > 0 ? ` · ${suggestionCount}` : ""}
        </span>
      </button>
      <button
        type="button"
        className="sb-item"
        onClick={toggleGrammarCheck}
        title={
          grammarCheck
            ? t("status.grammar.tooltip.on")
            : t("status.grammar.tooltip.off")
        }
        data-testid="status-grammar"
        aria-pressed={grammarCheck}
        style={{
          gap: 4,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
          color: grammarCheck ? "hsl(220 80% 65%)" : "hsl(var(--fg-muted))",
        }}
      >
        <SpellCheck size={10} />
        <span style={{ fontSize: 10, fontWeight: grammarCheck ? 600 : 400 }}>
          {grammarCheck ? t("status.grammar.on") : t("status.grammar.off")}
        </span>
      </button>
      <button
        type="button"
        className="sb-item"
        onClick={toggleTelemetry}
        title={
          telemetryOff
            ? t("status.telemetry.tooltip.off")
            : t("status.telemetry.tooltip.on")
        }
        data-testid="status-telemetry"
        aria-pressed={!telemetryOff}
        style={{
          gap: 4,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
          color: telemetryOff ? "hsl(var(--fg-muted))" : "hsl(140 60% 55%)",
        }}
      >
        <Activity size={10} />
        <span style={{ fontSize: 10, fontWeight: telemetryOff ? 400 : 600 }}>
          {telemetryOff ? t("status.telemetry.off") : t("status.telemetry.on")}
        </span>
      </button>
      {onOpenRuntimeMetrics && (
        <button
          type="button"
          className="sb-item"
          onClick={onOpenRuntimeMetrics}
          title={t("status.runtimeMetrics.tooltip")}
          data-testid="status-runtime-metrics"
          style={{
            gap: 4,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
            font: "inherit",
            color: "hsl(var(--accent))",
          }}
        >
          <BarChart3 size={10} />
          <span style={{ fontSize: 10, fontWeight: 600 }}>{t("status.runtimeMetrics")}</span>
        </button>
      )}
      {secretsMode === "plain" && (
        <span
          className="sb-item"
          role="status"
          title={t("status.secretsPlain.tooltip")}
          aria-label={t("status.secretsPlain.tooltip")}
          style={{ gap: 4, paddingInline: 4 }}
          data-testid="status-secrets-plain"
        >
          <AlertCircle size={10} style={{ color: "hsl(12 90% 58%)" }} aria-hidden="true" />
          <span style={{ color: "hsl(12 90% 58%)", fontSize: 10, fontWeight: 600 }}>{t("status.secretsPlain")}</span>
        </span>
      )}
      {useLocalAi && (
        <span
          className="sb-item"
          title={t("status.privacyMode.tooltip")}
          style={{ gap: 4 }}
          data-testid="status-privacy-mode"
        >
          <ShieldCheck
            size={10}
            style={{ color: "hsl(140 60% 55%)" }}
          />
          <span style={{ color: "hsl(140 60% 55%)", fontSize: 10, fontWeight: 600 }}>
            {t("status.privacyMode")}
          </span>
        </span>
      )}
      {aiKey && !useLocalAi && (
        <span className="sb-item" title="AI Copilot Active" style={{ gap: 4 }}>
          <Sparkles size={10} style={{ color: "hsl(var(--accent))", animation: "pulse 2s ease-in-out infinite" }} />
          <span style={{ color: "hsl(var(--accent))", fontSize: 10 }}>AI</span>
        </span>
      )}
      <a
        className="sb-item sb-accent"
        href="/roadmap"
        target="_blank"
        rel="noreferrer noopener"
        title={t("status.roadmap.tooltip")}
        style={{ textDecoration: "none", color: "inherit" }}
      >
        {t("status.roadmap")}
      </a>
      <span className="sb-item sb-accent">Lumen</span>
    </footer>
  );
});

interface Stats {
  words: number;
  chars: number;
  readingMin: number;
}

function computeStats(text: string): Stats {
  // Strip frontmatter and fenced code blocks for word count.
  const stripped = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/```[\s\S]*?```/g, "");

  // Words: letters of any script *with their combining marks* (a pointed
  // Hebrew word used to count as several), gershayim inside (צה״ל) — T26.
  const words = countWords(stripped);

  // Characters (excluding whitespace).
  const chars = stripped.replace(/\s+/g, "").length;

  // Reading time at ~220 wpm.
  const readingMin = Math.max(1, Math.round(words / 220));

  return { words, chars, readingMin };
}
