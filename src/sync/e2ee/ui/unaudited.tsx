/**
 * Plan W11.S1: the encrypted sync is off by default in every channel (the
 * experimental flag `sync.e2ee`, src/flags/flags.json) and says, on the
 * screen that turns it on, that its cryptography has not had an external
 * security audit. Both hold until security/crypto-audit.json names a
 * published report.
 *
 *   • `UnauditedNotice` — the label, shown on the gate, the guided setup
 *     and the sync panel.
 *   • `E2eeGate` — the screen a sync command shows while the flag is off:
 *     the label, and a button that turns the flag on for this device.
 *   • `whenE2eeOn(run)` — what the sync and classroom launchers call: runs
 *     at once when the flag is on, otherwise shows the gate first.
 */

import { createRoot, type Root } from "react-dom/client";
import { getLocale, t } from "../../../i18n";
import "../strings";
import { isEnabled, setFlag } from "../../../flags/flags";

export const E2EE_FLAG = "sync.e2ee";

export function UnauditedNotice() {
  return (
    <div data-testid="e2ee-unaudited" style={{ display: "grid", gap: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid hsl(var(--warning, var(--danger)))", fontSize: 13 }}>
      <strong>{t("e2ee.unaudited.badge")}</strong>
      <span style={{ color: "hsl(var(--fg-muted))" }}>{t("e2ee.unaudited.body")}</span>
    </div>
  );
}

const button: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, cursor: "pointer", font: "inherit" };

export function E2eeGate({ onEnable, onCancel }: { onEnable: () => void; onCancel: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "grid", placeItems: "center", zIndex: 1000 }} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="e2ee-gate-title"
        dir={getLocale() === "he" || getLocale() === "ar" ? "rtl" : "ltr"}
        data-testid="e2ee-gate"
        style={{ width: "min(480px, calc(100vw - 32px))", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 12, padding: 20, display: "grid", gap: 14 }}
      >
        <h2 id="e2ee-gate-title" style={{ margin: 0, fontSize: 18 }}>
          {t("e2ee.gate.title")}
        </h2>
        <UnauditedNotice />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" data-testid="e2ee-gate-enable" onClick={onEnable} style={{ ...button, border: "none", background: "hsl(var(--accent))", color: "white" }}>
            {t("e2ee.gate.enable")}
          </button>
          <button type="button" data-testid="e2ee-gate-cancel" onClick={onCancel} style={{ ...button, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit" }}>
            {t("e2ee.gate.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

let gate: { root: Root; host: HTMLElement } | null = null;

function closeGate(): void {
  gate?.root.unmount();
  gate?.host.remove();
  gate = null;
}

/** Run `run` if the encrypted sync is on; otherwise ask first, and run it only after the user turns it on. */
export async function whenE2eeOn(run: () => void | Promise<void>): Promise<void> {
  if (isEnabled(E2EE_FLAG)) return run();
  if (gate) return;
  const host = document.createElement("div");
  host.dataset.lumenE2eeGate = "";
  document.body.appendChild(host);
  const root = createRoot(host);
  gate = { root, host };
  await new Promise<void>((resolve) => {
    root.render(
      <E2eeGate
        onEnable={() => {
          setFlag(E2EE_FLAG, true);
          closeGate();
          resolve(Promise.resolve(run()).then(() => undefined));
        }}
        onCancel={() => {
          closeGate();
          resolve();
        }}
      />,
    );
  });
}
