/**
 * "Freshness not verified" (plan 3.4, step 9). A device that joined the
 * vault without pairing trusts the first manifest it saw (TOFU): it cannot
 * tell whether the provider showed it an old state. Until the user pairs it
 * with an existing device or confirms by hand, this banner says so — and
 * nothing in the UI claims rollback protection.
 */

import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { PairingError } from "../pairing";
import type { E2eeSync } from "../engine";
import "../strings";

type Freshness = Awaited<ReturnType<E2eeSync["freshness"]>>;

interface Props {
  sync: Pick<E2eeSync, "freshness" | "pair" | "confirmFreshness" | "onChange">;
}

export function FreshnessBanner({ sync }: Props) {
  const [state, setState] = useState<Freshness | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let reads = 0;
    // Re-read after every round, pairing or confirmation (2.31): a round can
    // revoke a verification. While a re-read is pending, or when it fails,
    // freshness is unknown, and "verified" is never shown for an unknown state.
    const read = () => {
      const n = ++reads;
      setState((prev: Freshness | null) => (prev?.verified ? null : prev));
      sync.freshness().then(
        (f) => live && n === reads && setState(f),
        () => live && n === reads && setState(null),
      );
    };
    read();
    const off = sync.onChange(read);
    return () => {
      live = false;
      off();
    };
  }, [sync]);

  async function act(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
      // The change listener re-reads too; this answers at once.
      setState(await sync.freshness().catch(() => null));
    } catch (e) {
      setError(e instanceof PairingError ? t("e2ee.fresh.badCode") : String((e as Error)?.message ?? e));
    }
  }

  if (!state) return null;
  if (state.verified) {
    return (
      <div role="status" style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
        {t("e2ee.fresh.verified")}
      </div>
    );
  }
  return (
    <div
      role="alert"
      style={{
        display: "grid",
        gap: 8,
        padding: "10px 12px",
        border: "1px solid hsl(40 90% 45%)",
        background: "hsl(40 90% 50% / 0.1)",
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      <div>{t("e2ee.fresh.unverified")}</div>
      <label style={{ display: "grid", gap: 4 }}>
        {t("e2ee.fresh.code")}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          dir="ltr"
          spellCheck={false}
          style={{ padding: "4px 6px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
        />
      </label>
      {error && <div style={{ color: "hsl(0 70% 50%)", fontSize: 12 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={!code.trim()} onClick={() => act(() => sync.pair(code))}>
          {t("e2ee.fresh.pair")}
        </button>
        <button type="button" disabled={state.counter === null} onClick={() => act(() => sync.confirmFreshness())}>
          {t("e2ee.fresh.confirm")}
        </button>
      </div>
    </div>
  );
}
