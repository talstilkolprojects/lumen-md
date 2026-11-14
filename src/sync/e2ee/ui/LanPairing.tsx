/**
 * Pairing two devices on the local network (plan W2.19): the host shows an
 * offer code (as a QR code and as text), the other device answers with a
 * code of its own, and the two connect directly, with no server and no
 * internet. Lives in the sync panel's lazy chunk.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { t } from "../../../i18n";
import "../strings";
import { encodeQr, qrPath } from "../../../lib/qr";
import { recordLanSync, setLanSyncBytes } from "../../../ai/privacyLedger";
import { hostOffer, joinOffer, LanLinkError, type LanLink } from "../lan/link";
import { LanAuthError } from "../lan/rpc";
import { adoptPeerLink, LanNoVaultError, LanNotConnectedError, serveOnLan, thisHost } from "../lan";
import type { LanPeerInfo } from "../lan/rpc";
import { explainError } from "../../../lib/userError";

const field: React.CSSProperties = { width: "100%", padding: "6px 8px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", fontSize: 12 };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const errorStyle: React.CSSProperties = { fontSize: 12, color: "hsl(var(--danger))" };

let dictationServed = false;

/**
 * Plan W6.19: a phone linked to this device may send its Hebrew dictation
 * here, to the bigger model, whichever of the two hosts the vault. Lazy:
 * nothing loads until a device is linked, and the model is only looked for
 * when a phone asks.
 */
function serveDictationOnce(): void {
  if (dictationServed) return;
  dictationServed = true;
  void import("../../../ai/dictation/desktopOffload")
    .then((m) => m.serveDesktopDictation({ serve: serveOnLan }, m.appDesktopEngine()))
    .catch(() => {
      dictationServed = false;
    });
}

/** A human message for a LAN failure (never the error's own text: explainError). */
export function describeLanError(e: unknown): string {
  if (e instanceof LanLinkError) return t(`e2ee.lan.error.${e.reason}`);
  if (e instanceof LanNoVaultError) return t("e2ee.lan.noVault");
  if (e instanceof LanNotConnectedError) return t("e2ee.lan.notConnected");
  if (e instanceof LanAuthError) return t("e2ee.lan.authFailed");
  return explainError(e, "lan");
}

/** The privacy ledger shows each link: the other device's LAN address and the bytes it carried. */
function trackInLedger(link: LanLink): void {
  const id = recordLanSync(link.remoteAddress ?? t("e2ee.lan.addressHidden"));
  const tick = () => {
    const b = link.bytes();
    setLanSyncBytes(id, b.out, b.in);
  };
  const timer = setInterval(tick, 2000);
  link.channel.onClose(() => {
    clearInterval(timer);
    tick();
  });
}

function QrSvg({ text }: { text: string }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(text, "M");
    } catch {
      return null;
    }
  }, [text]);
  if (!qr) return null;
  const n = qr.size + 8;
  return ( // design-allow: a QR code stays pure black on white in every theme, so phone cameras can read it
    <svg role="img" aria-label={t("e2ee.lan.qr")} viewBox={`0 0 ${n} ${n}`} width={Math.min(260, n * 4)} height={Math.min(260, n * 4)} shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 4, justifySelf: "start" }}>
      {/* design-allow: the QR modules are pure black (see above) */}
      <path d={qrPath(qr)} fill="#000" />
    </svg>
  );
}

function CodeBox({ code, testId }: { code: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <QrSvg text={code} />
      <textarea readOnly dir="ltr" value={code} data-testid={testId} rows={3} style={{ ...field, fontFamily: "monospace", fontSize: 11 }} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        style={{ justifySelf: "start" }}
        onClick={() =>
          void navigator.clipboard?.writeText(code).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? t("e2ee.lan.copied") : t("e2ee.lan.copy")}
      </button>
    </div>
  );
}

/** The joining device: paste the host's code, show an answer code, connect. */
export function LanJoin({ onLinked }: { onLinked: () => Promise<void> }) {
  const [offer, setOffer] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A pairing still waiting for the host: given up when the form goes away. */
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => pending.current?.(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const j = await joinOffer(offer);
      setAnswer(j.code);
      pending.current = j.cancel;
      const link = await j.link;
      pending.current = null;
      trackInLedger(link);
      adoptPeerLink(link);
      serveDictationOnce();
      await onLinked();
    } catch (err) {
      setError(describeLanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 8 }} aria-label={t("e2ee.lan.join.title")}>
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
        {t("e2ee.lan.join.paste")}
        <textarea dir="ltr" required rows={3} value={offer} onChange={(e) => setOffer(e.target.value)} data-testid="lan-offer-input" style={{ ...field, fontFamily: "monospace" }} />
      </label>
      {!answer && (
        <button type="submit" disabled={busy || !offer.trim()} style={{ justifySelf: "start" }}>
          {t("e2ee.lan.join.answer")}
        </button>
      )}
      {answer && (
        <>
          <div style={{ fontSize: 13 }}>{t("e2ee.lan.join.showBack")}</div>
          <CodeBox code={answer} testId="lan-answer-code" />
          {busy && (
            <div role="status" style={muted}>
              {t("e2ee.lan.waiting")}
            </div>
          )}
        </>
      )}
      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}
    </form>
  );
}

/** The hosting device: pair another device, see who is connected. */
export function LanHostPairing() {
  const [offer, setOffer] = useState<{ code: string; accept(a: string): Promise<LanLink>; cancel(): void } | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [peers, setPeers] = useState<LanPeerInfo[]>(() => thisHost().peers());
  useEffect(() => thisHost().onPeersChange(() => setPeers(thisHost().peers())), []);
  /** The offer not yet accepted: given up when the panel closes. */
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => pending.current?.(), []);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      pending.current?.();
      const o = await hostOffer();
      pending.current = o.cancel;
      setOffer(o);
      setAnswer("");
    } catch (err) {
      setError(describeLanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (!offer) return;
    setError(null);
    setBusy(true);
    try {
      const link = await offer.accept(answer);
      pending.current = null;
      trackInLedger(link);
      thisHost().attach(link.channel, { address: link.remoteAddress });
      serveDictationOnce();
      setOffer(null); // used up: the next pairing makes a new offer
    } catch (err) {
      setError(describeLanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ display: "grid", gap: 8, paddingTop: 10, borderTop: "1px solid hsl(var(--border))" }} aria-label={t("e2ee.lan.pair")}>
      <div style={{ fontWeight: 600 }}>{t("e2ee.lan.pair")}</div>
      <div style={muted}>{t("e2ee.lan.hostNote")}</div>
      <div role="status" data-testid="lan-peers" data-count={peers.length} style={{ fontSize: 13 }}>
        {t("e2ee.lan.peers", { n: peers.length })}
        {peers.length > 0 && (
          <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
            {peers.map((p) => (
              <li key={p.connectedAt} dir="auto">
                <bdi dir="ltr">{p.address ?? t("e2ee.lan.addressHidden")}</bdi> · {p.authed ? t("e2ee.lan.peer.authed") : t("e2ee.lan.peer.pending")}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!offer && (
        <button type="button" onClick={() => void start()} disabled={busy} style={{ justifySelf: "start" }}>
          {t("e2ee.lan.pair.start")}
        </button>
      )}
      {offer && (
        <form onSubmit={connect} style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13 }}>{t("e2ee.lan.pair.show")}</div>
          <CodeBox code={offer.code} testId="lan-offer-code" />
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            {t("e2ee.lan.pair.paste")}
            <textarea dir="ltr" required rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="lan-answer-input" style={{ ...field, fontFamily: "monospace" }} />
          </label>
          <button type="submit" disabled={busy || !answer.trim()} style={{ justifySelf: "start" }}>
            {t("e2ee.lan.pair.connect")}
          </button>
        </form>
      )}
      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}
    </section>
  );
}
