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
import { announcePairing, discoveryAvailable, DiscoveryError, findDevices, joinFound, pairingCode, type FoundDevice } from "../lan/discovery";
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
  // "unverifiable" (no fingerprints on a network pairing) also reads "use the code instead".
  if (e instanceof DiscoveryError) return t(e.reason === "used" || e.reason === "token" ? "e2ee.lan.discovery.used" : e.reason === "not-lan" ? "e2ee.lan.error.not-lan" : "e2ee.lan.discovery.failed");
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
  const canFind = useMemo(() => discoveryAvailable(), []);
  const [found, setFound] = useState<FoundDevice[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [compare, setCompare] = useState<{ code: string; resolve: (same: boolean) => void } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await join(async () => {
      const j = await joinOffer(offer);
      setAnswer(j.code);
      pending.current = j.cancel;
      return j;
    });
  }

  /** Plan W2.19 mDNS: pair with a device found on the network, no code to copy. */
  async function pick(device: FoundDevice) {
    await join(() =>
      joinFound(device, async (code) => {
        const j = await joinOffer(code);
        pending.current = j.cancel;
        return j;
      }).catch(async (e) => {
        // Review 28, L2: the pairing was used by someone else. The host makes a fresh one under a new name: look again.
        if (e instanceof DiscoveryError && (e.reason === "used" || e.reason === "token")) void find();
        throw e;
      }),
      true,
    );
  }

  async function find() {
    setError(null);
    setFinding(true);
    try {
      setFound(await findDevices());
    } catch (err) {
      setError(lanError(err));
    } finally {
      setFinding(false);
    }
  }

  async function join(start: () => Promise<{ link: Promise<LanLink> }>, viaNetwork = false) {
    setError(null);
    setBusy(true);
    try {
      const j = await start();
      const link = await j.link;
      pending.current = null;
      // Review 28, L1: before anything syncs, both screens show the channel's code; the user checks they match.
      pending.current = () => link.close();
      let code: string | null;
      try {
        code = await pairingCode("peer", link.fingerprints, { viaNetwork });
      } catch (e) {
        link.close();
        throw e;
      }
      if (code && !(await new Promise<boolean>((resolve) => setCompare({ code, resolve })))) {
        link.close();
        setCompare(null);
        setError(t("e2ee.lan.compare.mismatch"));
        return;
      }
      setCompare(null);
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
      {canFind && !answer && (
        <div style={{ display: "grid", gap: 6 }}>
          <button type="button" onClick={() => void find()} disabled={finding || busy} style={{ justifySelf: "start" }} data-testid="lan-find">
            {t("e2ee.lan.find")}
          </button>
          {finding && (
            <div role="status" style={muted}>
              {t("e2ee.lan.finding")}
            </div>
          )}
          {found && !finding && found.length === 0 && (
            <div role="status" style={muted}>
              {t("e2ee.lan.found.none")}
            </div>
          )}
          {found && found.length > 0 && (
            <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 4 }} data-testid="lan-found">
              {found.map((d) => (
                <li key={`${d.name}|${d.host}|${d.port}`}>
                  <button type="button" onClick={() => void pick(d)} disabled={busy}>
                    {t("e2ee.lan.found.pick", { name: d.name })}
                  </button>{" "}
                  <bdi dir="ltr" style={muted}>{d.host}</bdi>
                  {d.duplicate && (
                    <div role="alert" style={errorStyle}>
                      {t("e2ee.lan.found.duplicate", { name: d.name })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
        {t("e2ee.lan.join.paste")}
        <textarea dir="ltr" required rows={3} value={offer} onChange={(e) => setOffer(e.target.value)} data-testid="lan-offer-input" style={{ ...field, fontFamily: "monospace" }} />
      </label>
      {!answer && (
        <button type="submit" disabled={busy || !offer.trim()} style={{ justifySelf: "start" }}>
          {t("e2ee.lan.join.answer")}
        </button>
      )}
      {compare && (
        <div role="group" aria-label={t("e2ee.lan.compare.title")} style={{ display: "grid", gap: 6 }} data-testid="lan-compare">
          <div style={{ fontSize: 13 }}>{t("e2ee.lan.compare.ask")}</div>
          <bdi dir="ltr" style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700 }} data-testid="lan-compare-code">
            {compare.code}
          </bdi>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => compare.resolve(true)}>
              {t("e2ee.lan.compare.same")}
            </button>
            <button type="button" onClick={() => compare.resolve(false)}>
              {t("e2ee.lan.compare.differ")}
            </button>
          </div>
        </div>
      )}
      {answer && !compare && (
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

  // Plan W2.19 mDNS: in the desktop app, this pairing is also visible on the network until it is used.
  const [visibleAs, setVisibleAs] = useState<string | null>(null);
  useEffect(() => {
    if (!offer || !discoveryAvailable()) return;
    const ctl = new AbortController();
    void announcePairing(offer.code, { signal: ctl.signal })
      .then(({ name, answer: came }) => {
        if (ctl.signal.aborted) return;
        setVisibleAs(name);
        void came.then(async (a) => {
          if (!a || ctl.signal.aborted) return;
          await accept(offer, a, true);
          // Review 28, L2: an answer from the network uses the pairing up, whoever sent it. Make a fresh
          // offer under a new name, so the user's own device can still pair if another one got there first.
          if (!ctl.signal.aborted) void start();
        });
      })
      .catch(() => setVisibleAs(null));
    return () => {
      ctl.abort();
      setVisibleAs(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one announcement per offer
  }, [offer]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (!offer) return;
    await accept(offer, answer);
  }

  async function accept(o: NonNullable<typeof offer>, code: string, viaNetwork = false) {
    setError(null);
    setBusy(true);
    try {
      const link = await o.accept(code);
      // Review 31, L1b: an answer from the network with no fingerprints can't be compared: refuse it.
      try {
        await pairingCode("host", link.fingerprints, { viaNetwork });
      } catch (e) {
        link.close();
        throw e;
      }
      pending.current = null;
      trackInLedger(link);
      thisHost().attach(link.channel, { address: link.remoteAddress, fingerprints: link.fingerprints });
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
                {p.code && (
                  <>
                    {" · "}
                    {t("e2ee.lan.peer.code")} <bdi dir="ltr" data-testid="lan-peer-code" style={{ fontFamily: "monospace", fontWeight: 600 }}>{p.code}</bdi>
                  </>
                )}
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
          {visibleAs && (
            <div role="status" style={muted} data-testid="lan-visible-as">
              {t("e2ee.lan.visibleAs", { name: visibleAs })}
            </div>
          )}
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
