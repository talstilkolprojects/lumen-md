/**
 * The activity panel (plan W1.8): the running round's progress and time
 * left, how many files are in each state, the files that need attention
 * (conflicts, errors, waiting), and the latest steps the sync took — each
 * upload and download, what it kept on this device, every conflict the
 * moment it is found.
 */

import { useEffect, useSyncExternalStore } from "react";
import { getLocale, t } from "../../../i18n";
import "../strings";
import type { SyncEvent } from "../activity";
import { describeSecondsLeft, type Progress } from "../estimate";
import { countStates, type FileStatus } from "../status";
import type { SyncSession } from "./session";

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2, fontSize: 12, maxHeight: 180, overflow: "auto" };

/** "1.2 MB" in the interface language. */
export function formatBytes(n: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  try {
    return new Intl.NumberFormat(getLocale(), { style: "unit", unit: units[i], unitDisplay: "short", maximumFractionDigits: i ? 1 : 0 }).format(v);
  } catch {
    return `${Math.round(v * 10) / 10} ${["B", "KB", "MB", "GB"][i]}`;
  }
}

/** A rule as the user reads it: "folder Videos", "type .mp4", "over 20 MB". */
export function describeRule(reason: string): string {
  const [kind, value] = [reason.slice(0, reason.indexOf(":")), reason.slice(reason.indexOf(":") + 1)];
  if (kind === "folder") return t("e2ee.rule.folder", { value });
  if (kind === "type") return t("e2ee.rule.type", { value });
  if (kind === "size") return t("e2ee.rule.size", { value: formatBytes(Number(value)) });
  return reason;
}

/** One line of the activity list. */
export function describeEvent(e: SyncEvent): string {
  switch (e.kind) {
    case "start":
      return t("e2ee.activity.start");
    case "plan":
      return "";
    case "upload":
      return t("e2ee.activity.upload", { path: e.path, size: formatBytes(e.bytes) });
    case "download":
      return t("e2ee.activity.download", { path: e.path, size: formatBytes(e.bytes) });
    case "delete":
      return t(e.direction === "up" ? "e2ee.activity.deleteUp" : "e2ee.activity.deleteDown", { path: e.path });
    case "conflict":
      return t("e2ee.activity.conflict", { path: e.path });
    case "held":
      return t(`e2ee.activity.held.${e.reason}`, { path: e.path });
    case "excluded":
      return t("e2ee.activity.excluded", { path: e.path, rule: describeRule(e.reason) });
    case "done":
      return t("e2ee.activity.done", { up: e.uploaded, down: e.downloaded, deleted: e.deleted });
    case "error":
      return t("e2ee.activity.error", { message: e.message });
  }
}

function ProgressLine({ p }: { p: Progress }) {
  const eta = describeSecondsLeft(p.secondsLeft);
  return (
    <div style={{ display: "grid", gap: 4 }} data-testid="sync-progress">
      <progress value={Math.round(p.fraction * 1000)} max={1000} style={{ width: "100%" }} aria-label={t("e2ee.activity.title")} />
      <div style={muted} role="status">
        {t("e2ee.progress", { done: p.filesDone, total: p.files, bytesDone: formatBytes(p.bytesDone), bytes: formatBytes(p.bytes) })} · {eta ? t(eta.key, eta.n === undefined ? undefined : { n: eta.n }) : t("e2ee.eta.unknown")}
      </div>
    </div>
  );
}

const ATTENTION: Record<string, number> = { error: 0, conflict: 1, pending: 2 };

function Attention({ files }: { files: ReadonlyMap<string, FileStatus> }) {
  const rows = [...files].filter(([, st]) => st.state in ATTENTION).sort((a, b) => ATTENTION[a[1].state] - ATTENTION[b[1].state] || a[0].localeCompare(b[0]));
  if (!rows.length) return null;
  return (
    <section aria-labelledby="sync-attention" style={{ display: "grid", gap: 4 }}>
      <div id="sync-attention" style={{ fontWeight: 600, fontSize: 13 }}>
        {t("e2ee.activity.attention")}
      </div>
      <ul style={list} data-testid="sync-attention">
        {rows.slice(0, 50).map(([path, st]) => (
          <li key={path} data-state={st.state} style={{ display: "flex", gap: 8 }}>
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <bdi dir="auto">{path}</bdi>
            </span>
            <span style={muted}>{t(`e2ee.state.${st.state}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SyncActivity({ session }: { session: SyncSession }) {
  const s = useSyncExternalStore(session.subscribe, session.get);
  const events = useSyncExternalStore(session.activity.subscribe, session.activity.list);

  useEffect(() => {
    // Opening the panel lists the vault again, so edits since the last round show.
    void session.refreshStates().catch(() => undefined);
  }, [session]);

  const counts = s.files ? countStates(s.files) : null;
  const shown = events.filter((e) => e.kind !== "plan").slice(-60).reverse();

  return (
    <section aria-labelledby="sync-activity-title" style={{ display: "grid", gap: 8, paddingTop: 10, borderTop: "1px solid hsl(var(--border))" }}>
      <div id="sync-activity-title" style={{ fontWeight: 600 }}>
        {t("e2ee.activity.title")}
      </div>
      {s.progress && <ProgressLine p={s.progress} />}
      {counts && (
        <div style={muted} data-testid="sync-counts">
          {t("e2ee.activity.summary", { synced: counts.synced, pending: counts.pending, conflict: counts.conflict, error: counts.error, excluded: counts.excluded })}
        </div>
      )}
      {s.files && <Attention files={s.files} />}
      {shown.length === 0 ? (
        // empty-action: "Sync now" in this panel, above
        <div style={muted}>{t("e2ee.activity.empty")}</div>
      ) : (
        <ul style={list} data-testid="sync-activity" aria-live="polite">
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`} data-kind={e.kind} style={{ display: "flex", gap: 8 }}>
              <time style={{ ...muted, flexShrink: 0 }} dateTime={new Date(e.at).toISOString()}>
                {new Date(e.at).toLocaleTimeString(getLocale())}
              </time>
              <bdi dir="auto" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {describeEvent(e)}
              </bdi>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
