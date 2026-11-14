/**
 * The pairing comparison (plan W8.5, seventh review 12.11 G4): the five
 * symbols this device derived, to compare with the other device's, and the
 * two answers. Shown on both devices while they pair: on the new one after
 * it read a code or an answer, on the existing one after it made one. The
 * new device is paired only when the user said "They match" on both.
 *
 * The symbols are always laid out left to right and numbered, whatever the
 * language's direction: a Hebrew device and an English one must show them
 * in the same order.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../../../i18n";
import type { E2eeSync, PairingComparison } from "../engine";
import { e2eeErrorText } from "./errorText";
import "../strings";

type Phase = "waitingKey" | "compare" | "waitingConfirm" | "done" | "aborted";

interface Props {
  sync: Pick<E2eeSync, "pairingSas" | "confirmPairing" | "rejectPairing">;
  /** Called once when the pairing ends on this device. */
  onEnd?: (outcome: "done" | "aborted") => void;
  /** How often to ask for the other device's key or confirmation (ms). */
  pollMs?: number;
}

export function PairingCompare({ sync, onEnd, pollMs = 1000 }: Props) {
  const [phase, setPhase] = useState<Phase>("waitingKey");
  const [sas, setSas] = useState<PairingComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ended = useRef(false);
  const end = (outcome: "done" | "aborted") => {
    if (ended.current) return;
    ended.current = true;
    onEnd?.(outcome);
  };

  // Ask for the symbols until the other device's key has arrived.
  useEffect(() => {
    if (phase !== "waitingKey") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void sync.pairingSas().then(
        (s) => {
          if (!live) return;
          if (s) {
            setSas(s);
            setPhase("compare");
          } else timer = setTimeout(tick, pollMs);
        },
        (e) => {
          if (!live) return;
          setError(e2eeErrorText(e, "pair"));
          setPhase("aborted");
          end("aborted");
        },
      );
    };
    tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sync, pollMs]);

  // After "They match": confirm, then ask until the other device has confirmed too.
  useEffect(() => {
    if (phase !== "waitingConfirm") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void sync.confirmPairing().then(
        (r) => {
          if (!live) return;
          if (r === "done") {
            setPhase("done");
            end("done");
          } else timer = setTimeout(tick, pollMs);
        },
        (e) => {
          if (!live) return;
          setError(e2eeErrorText(e, "pair"));
          setPhase("aborted");
          end("aborted");
        },
      );
    };
    tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sync, pollMs]);

  const mismatch = () => {
    void sync.rejectPairing().finally(() => {
      setPhase("aborted");
      end("aborted");
    });
  };

  return (
    <section aria-label={t("e2ee.sas.title")} data-testid="pairing-compare" style={{ display: "grid", gap: 8 }}>
      <strong>{t("e2ee.sas.title")}</strong>
      {phase === "waitingKey" && <div role="status">{t("e2ee.sas.waitingKey")}</div>}
      {sas && (phase === "compare" || phase === "waitingConfirm") && (
        <>
          <div>{t("e2ee.sas.prompt")}</div>
          <ol dir="ltr" data-testid="pairing-symbols" style={{ display: "flex", gap: 8, flexWrap: "wrap", listStyle: "none", margin: 0, padding: 0 }}>
            {sas.symbols.map((n, i) => (
              <li key={i} style={{ display: "grid", justifyItems: "center", gap: 2, minWidth: 64, padding: "6px 4px", border: "1px solid hsl(var(--border))", borderRadius: 8 }}>
                <span aria-hidden="true" style={{ fontSize: 10, color: "hsl(var(--fg-muted))" }}>
                  {i + 1}
                </span>
                <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1.1 }}>
                  {sas.emoji[i]}
                </span>
                <span style={{ fontSize: 12 }}>{t(`e2ee.sas.w${n}`)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {phase === "compare" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setPhase("waitingConfirm")}>
            {t("e2ee.sas.match")}
          </button>
          <button type="button" onClick={mismatch}>
            {t("e2ee.sas.mismatch")}
          </button>
        </div>
      )}
      {phase === "waitingConfirm" && (
        <>
          <div role="status">{t("e2ee.sas.waitingConfirm")}</div>
          <button type="button" style={{ justifySelf: "start" }} onClick={mismatch}>
            {t("e2ee.sas.mismatch")}
          </button>
        </>
      )}
      {phase === "done" && <div role="status">{t("e2ee.sas.done")}</div>}
      {phase === "aborted" && <div role="alert">{error ?? t("e2ee.sas.aborted")}</div>}
    </section>
  );
}
