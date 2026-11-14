/**
 * The network monitor (plan W5.9): every network attempt the app makes, live
 * — allowed, blocked, local or cache-only — with where in the code it came
 * from, the airplane-mode switch, and the certificate of the airplane-mode
 * window. Also the small "Airplane mode" badge shown while the switch is on.
 *
 * Loaded on use (the palette, the badge); src/privacy/airplane.ts does the
 * work and keeps the list.
 */
import "./airplaneStrings";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Plane, X } from "lucide-react";
import { t, getLocale } from "../i18n";
import { airplaneModeOn, airplaneSince, disableAirplaneMode, egressAttempts, enableAirplaneMode, subscribeEgress, type EgressAttempt } from "./airplane";
import { buildCertificate, reachedNetwork, sealCertificate } from "./airplaneCertificate";
import { HelpButton } from "../ui/HelpButton";

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const cell: React.CSSProperties = { padding: "3px 6px", borderBottom: "1px solid hsl(var(--border))", verticalAlign: "top" };

const DECISION_COLOR: Record<EgressAttempt["decision"], string> = {
  allowed: "hsl(35 90% 50%)",
  blocked: "hsl(0 70% 55%)",
  "cache-only": "hsl(var(--fg-muted))",
  local: "hsl(140 50% 45%)",
  "in-flight": "hsl(35 90% 50%)",
};

const decisionLabel = (d: EgressAttempt["decision"]) =>
  ({ allowed: t("airplane.decision.allowed"), blocked: t("airplane.decision.blocked"), "cache-only": t("airplane.decision.cache-only"), local: t("airplane.decision.local"), "in-flight": t("airplane.decision.in-flight") })[d];

const time = (ms: number) => new Date(ms).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Turn the switch off, after the user agreed to the reload. */
export async function confirmAirplaneOff(): Promise<void> {
  const { uiConfirm } = await import("../ui/PromptDialog");
  const yes = await uiConfirm({ title: t("airplane.confirmOff.title"), message: t("airplane.confirmOff.body"), okLabel: t("airplane.confirmOff.ok") });
  if (yes) disableAirplaneMode();
}

/** Turn the switch on now, and show the badge. */
export function turnAirplaneOn(): void {
  enableAirplaneMode();
  showAirplaneBadge();
}

export function NetworkMonitor({ onClose }: { onClose: () => void }) {
  const list = useSyncExternalStore(subscribeEgress, egressAttempts, egressAttempts);
  const on = airplaneModeOn();
  const since = airplaneSince();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = on && since !== null ? list.filter((a) => a.ts >= since) : list;
  const certificate = async () => {
    if (since === null) return;
    const to = Date.now();
    const sealed = await sealCertificate(buildCertificate(list, since, to));
    download(JSON.stringify({ certificate: sealed.text, sha256: sealed.sha256 }, null, 2) + "\n", `lumen-airplane-${new Date(since).toISOString().replace(/[:.]/g, "-")}.json`);
  };

  return (
    <div className="cmd-palette-backdrop">
      <div className="cmd-palette" role="dialog" aria-modal="true" aria-label={t("airplane.title")} data-testid="network-monitor" style={{ maxWidth: 900, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Plane size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("airplane.title")}</h2>
          <HelpButton topic="ai/airplane-mode#the-monitor-and-the-certificate" />
          <button ref={closeRef} type="button" style={ghost} onClick={onClose} aria-label={t("airplane.close")}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, overflow: "hidden" }}>
          <p style={{ margin: 0 }} role="status" data-testid="airplane-state" data-on={on ? "1" : "0"}>
            {on && since !== null ? t("airplane.state.on", { time: time(since) }) : t("airplane.state.off")}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {on ? (
              <button type="button" style={ghost} onClick={() => void confirmAirplaneOff()} data-testid="airplane-off">
                {t("airplane.turnOff")}
              </button>
            ) : (
              <button type="button" style={primary} onClick={turnAirplaneOn} data-testid="airplane-on">
                {t("airplane.turnOn")}
              </button>
            )}
            <button
              type="button"
              style={ghost}
              title={t("airplane.test.hint")}
              data-testid="airplane-test"
              onClick={() => {
                fetch("https://example.com/", { mode: "no-cors", cache: "no-store" }).catch(() => {
                  /* why: blocked or offline — the attempt is listed either way */
                });
              }}
            >
              {t("airplane.test")}
            </button>
            {on && (
              <button type="button" style={ghost} title={t("airplane.certificate.hint")} onClick={() => void certificate()} data-testid="airplane-certificate">
                {t("airplane.certificate")}
              </button>
            )}
            <span style={muted} data-testid="airplane-counts">
              {t("airplane.counts", { attempts: shown.length, blocked: shown.filter((a) => a.decision === "blocked").length, left: shown.filter(reachedNetwork).length })}
            </span>
          </div>
          {on && <p style={{ ...muted, margin: 0 }}>{t("airplane.certificate.unsigned")}</p>}
          <div style={{ overflow: "auto", border: "1px solid hsl(var(--border))", borderRadius: 6, minHeight: 120 }}>
            {shown.length === 0 ? (
              // empty-action: the airplane-mode on / off buttons above
              <p style={{ ...muted, padding: 12, margin: 0 }}>{t("airplane.empty")}</p>
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }} data-testid="airplane-list">
                <thead>
                  <tr style={{ textAlign: "start" }}>
                    <th style={cell}>{t("airplane.col.time")}</th>
                    <th style={cell}>{t("airplane.col.kind")}</th>
                    <th style={cell}>{t("airplane.col.decision")}</th>
                    <th style={cell}>{t("airplane.col.target")}</th>
                    <th style={cell}>{t("airplane.col.origin")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...shown].reverse().map((a) => (
                    <tr key={a.id} data-decision={a.decision} data-kind={a.kind}>
                      <td style={cell}>{time(a.ts)}</td>
                      <td style={cell}>{a.kind}</td>
                      <td style={{ ...cell, color: DECISION_COLOR[a.decision], fontWeight: 600 }}>{decisionLabel(a.decision)}</td>
                      <td style={{ ...cell, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }} dir="ltr">
                        {a.method} {a.target}
                      </td>
                      <td style={{ ...cell, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }} dir="ltr">
                        {a.origin}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p style={{ ...muted, margin: 0 }}>{t("airplane.limits")}</p>
        </div>
      </div>
    </div>
  );
}

let openHost: { close: () => void } | null = null;

/** Open the monitor (one at a time). */
export function openNetworkMonitor(): void {
  openHost?.close();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (openHost?.close === close) openHost = null;
    try {
      root.unmount();
    } catch {
      /* why: already unmounted by an earlier close */
    }
    host.remove();
  };
  openHost = { close };
  root.render(<NetworkMonitor onClose={close} />);
}

/** The "Airplane mode" badge while the switch is on (it opens the monitor). */
export function showAirplaneBadge(): void {
  if (document.getElementById("lumen-airplane-badge")) return;
  const b = document.createElement("button");
  b.id = "lumen-airplane-badge";
  b.type = "button";
  b.dataset.testid = "airplane-badge";
  b.textContent = `✈ ${t("airplane.badge")}`;
  b.title = t("airplane.badge.hint");
  b.style.cssText =
    "position:fixed;bottom:12px;inset-inline-start:12px;z-index:60;padding:4px 10px;border-radius:999px;border:1px solid hsl(var(--accent));background:hsl(var(--bg));color:hsl(var(--fg));font-size:12px;cursor:pointer;";
  b.addEventListener("click", openNetworkMonitor);
  document.body.appendChild(b);
}
