/**
 * The participant's panel for a self-guided usability session (plan
 * W4.25): consent, then the ten tasks one at a time (the instruction on
 * screen, a timer, "Done" / "I couldn't do it"), the ease question after
 * each, SUS at the end, and a .zip to save and send. Opt-in from the
 * palette (*Usability test (self-guided)…*); nothing is recorded before
 * consent, everything stays on the device until the participant sends the
 * file. Where a task's result is in the notes, the app checks it and keeps
 * only yes / no (unmoderated.ts). The panel's progress is read back from
 * the session itself, so a reload continues where it was.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getLocale, t } from "../i18n";
import "../research/usability/selfStrings";
import { downloadBytes } from "../storage/exportFormats";
import { zip } from "../storage/zip";
import { deleteSession, endSession, exportFile, listen, loadSession, record, setSeq, setSus, startSession, type Session } from "../research/usability/sessionRecorder";
import { SEQ_QUESTION, SUS_ITEMS, SUS_SCALE, TASKS } from "../research/usability/study";
import { newSelfCode, outcomeOf, SCRIPTS, SEED_FOLDER, seedPracticeNotes, stepOf, verifyTask, type VaultAccess } from "../research/usability/unmoderated";
import { uiStrings } from "../research/usability/uiStrings";
import { useAppStore } from "../store/useStore";
import { version as appVersion } from "../../package.json";

const box: CSSProperties = { position: "fixed", insetBlockEnd: 12, insetInlineEnd: 12, zIndex: 80, inlineSize: "min(400px, calc(100vw - 24px))", maxBlockSize: "75vh", overflowY: "auto", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 10, boxShadow: "0 8px 30px hsl(0 0% 0% / 0.25)", padding: 14, fontSize: 14, lineHeight: 1.5 };
const row: CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBlock: 8 };
const big: CSSProperties = { minBlockSize: 44, paddingInline: 14 };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The notes as they are now: the vault, with the open note and tabs as typed (they may not be saved yet). */
async function vaultNow(): Promise<VaultAccess> {
  const { listWorkspace, readWorkspaceFile } = await import("../storage/workspace");
  const st = useAppStore.getState();
  const live = new Map<string, string>();
  for (const tab of st.openTabs) live.set(tab.workspaceName ?? tab.name, tab.content);
  live.set(st.doc.workspaceName ?? st.doc.name, st.doc.content);
  const saved = (await listWorkspace().catch(() => [])).map((e) => e.path).filter((p) => /\.md$/i.test(p));
  return {
    list: async () => [...new Set([...saved, ...live.keys()])],
    read: async (p) => live.get(p) ?? readWorkspaceFile(p),
  };
}

export function UsabilitySelfPanel({ onClose }: { onClose: () => void }) {
  const lang = getLocale() === "he" ? "he" : "en";
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [, force] = useState(0);
  const [consent, setConsent] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sus, setSusAnswers] = useState<number[]>(Array(10).fill(0));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const strings = useMemo(() => uiStrings(), []);
  const stop = useRef<(() => void) | null>(null);
  const step = stepOf(session);
  const refresh = () => force((n) => n + 1);

  useEffect(() => {
    if (!session || session.endedAt) return;
    stop.current = listen(session, strings);
    return () => {
      stop.current?.();
      stop.current = null;
    };
  }, [session, strings]);

  // The task timer.
  useEffect(() => {
    if (step.kind !== "running") return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [step.kind]);

  const begin = async () => {
    setBusy(true);
    try {
      const s = startSession({
        participant: newSelfCode(),
        round: 1,
        consent,
        mode: "unmoderated",
        app: { version: appVersion, locale: getLocale(), dir: document.documentElement.dir || "ltr", viewport: `${window.innerWidth}x${window.innerHeight}`, touch: typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches },
      });
      try {
        const [{ SEED_NOTES }, ws, trash, events] = await Promise.all([import("../research/usability/seedNotes"), import("../storage/workspace"), import("../storage/trash"), import("../storage/workspaceEvents")]);
        await seedPracticeNotes(
          {
            exists: (p) => ws.workspaceHasFile(p),
            write: (p, text) => ws.writeWorkspaceFile(p, text),
            trash: async (p) => void (await trash.moveToTrash([p])),
          },
          SEED_NOTES,
        );
        events.notifyWorkspaceChanged();
      } catch (e) {
        setError(t("usabilitySelf.seedFailed", { error: e instanceof Error ? e.message : String(e) }));
      }
      setSession(s);
    } finally {
      setBusy(false);
    }
  };

  const startTask = (task: number) => {
    if (!session) return;
    record(session, { t: Date.now(), type: "task-start", task });
    setNowMs(Date.now());
    refresh();
  };

  const endTask = async (task: number, since: number, report: "done" | "gave-up") => {
    if (!session) return;
    setBusy(true);
    try {
      const at = Date.now();
      let verified: boolean | null = null;
      if (report === "done") {
        try {
          verified = await verifyTask(task, await vaultNow(), today());
        } catch {
          verified = null; // why: the notes could not be read; the participant's own report stands
        }
      }
      record(session, { t: at, type: "task-end", task, outcome: outcomeOf(report, verified, (at - since) / 1000, task), assisted: false, verified });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const answerSeq = (task: number, v: number) => {
    if (!session) return;
    setSeq(session, task, v);
    refresh();
  };

  const finish = () => {
    if (!session) return;
    setSus(session, sus);
    endSession(session);
    stop.current?.();
    refresh();
  };

  const stopNow = () => {
    if (!session || !window.confirm(t("usabilitySelf.stop.confirm"))) return;
    endSession(session);
    stop.current?.();
    refresh();
  };

  const save = async () => {
    if (!session) return;
    const f = exportFile(session);
    const readme = `${t("usabilitySelf.readme", { code: session.participant })}\n`;
    const bytes = await zip([
      { name: f.name, data: f.text, store: true },
      { name: "README.txt", data: readme, store: true },
    ]);
    downloadBytes(f.name.replace(/\.json$/, ".zip"), bytes, "application/zip");
  };

  const remove = () => {
    if (!window.confirm(t("usabilitySelf.delete.confirm"))) return;
    stop.current?.();
    deleteSession();
    setSession(null);
    onClose();
  };

  if (collapsed) {
    return (
      <button type="button" data-usability-panel onClick={() => setCollapsed(false)} style={{ ...box, inlineSize: "auto", padding: "8px 12px", cursor: "pointer" }}>
        ● {step.kind === "running" || step.kind === "task" ? t("usabilitySelf.taskOf", { n: step.task, total: TASKS.length }) : t("usabilitySelf.title")} · {t("usabilitySelf.show")}
      </button>
    );
  }

  const elapsed = step.kind === "running" ? Math.max(0, Math.floor((nowMs - step.since) / 1000)) : 0;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <section data-usability-panel data-testid="usability-self" aria-labelledby="usability-self-title" style={box}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <h2 id="usability-self-title" style={{ flex: 1, margin: 0, fontSize: 15, fontWeight: 600 }}>
          {t("usabilitySelf.title")}
        </h2>
        {session && step.kind !== "done" && (
          <button type="button" className="btn" onClick={() => setCollapsed(true)} aria-label={t("usabilitySelf.hide")} title={t("usabilitySelf.hide")}>
            –
          </button>
        )}
        {!session && (
          <button type="button" className="btn" onClick={onClose} aria-label={t("usability.close")}>
            ✕
          </button>
        )}
      </div>
      {session && <p style={{ margin: "4px 0", fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("usabilitySelf.code", { code: session.participant })}</p>}
      {error && (
        <p role="alert" style={{ margin: "4px 0", fontSize: 12 }}>
          {error}
        </p>
      )}

      {step.kind === "intro" && (
        <div>
          <p style={{ margin: "8px 0" }}>{t("usabilitySelf.intro")}</p>
          <p style={{ margin: "8px 0 2px", fontWeight: 600 }}>{t("usabilitySelf.records")}</p>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            <li>{t("usabilitySelf.records.time")}</li>
            <li>{t("usabilitySelf.records.clicks")}</li>
            <li>{t("usabilitySelf.records.check")}</li>
            <li>{t("usabilitySelf.records.answers")}</li>
          </ul>
          <p style={{ margin: "8px 0" }}>{t("usabilitySelf.privacy")}</p>
          <p style={{ margin: "8px 0", fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("usabilitySelf.setupNote", { folder: SEED_FOLDER })}</p>
          <label style={{ ...row, alignItems: "flex-start" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="usability-self-consent" />
            <span>{t("usabilitySelf.consent")}</span>
          </label>
          <button type="button" className="btn btn-primary" style={big} disabled={!consent || busy} onClick={() => void begin()} data-testid="usability-self-start">
            {t("usabilitySelf.start")}
          </button>
        </div>
      )}

      {(step.kind === "task" || step.kind === "running") && (
        <div>
          <p style={{ margin: "8px 0 4px", fontWeight: 600 }}>
            {t("usabilitySelf.taskOf", { n: step.task, total: TASKS.length })} · {TASKS[step.task - 1][lang]}
          </p>
          <p data-testid="usability-self-script" style={{ margin: "4px 0 8px" }}>
            {SCRIPTS[step.task][lang]}
          </p>
          {step.kind === "task" ? (
            <button type="button" className="btn btn-primary" style={big} onClick={() => startTask(step.task)} data-testid="usability-self-begin">
              {t("usabilitySelf.begin")}
            </button>
          ) : (
            <>
              <p aria-live="off" style={{ margin: "4px 0", fontVariantNumeric: "tabular-nums" }} dir="ltr">
                ⏱ {mmss}
              </p>
              {elapsed > TASKS[step.task - 1].limitMin * 60 && <p style={{ margin: "4px 0", fontSize: 12 }}>{t("usabilitySelf.overLimit")}</p>}
              <div style={row}>
                <button type="button" className="btn btn-primary" style={big} disabled={busy} onClick={() => void endTask(step.task, step.since, "done")} data-testid="usability-self-done">
                  {t("usabilitySelf.done")}
                </button>
                <button type="button" className="btn" style={big} disabled={busy} onClick={() => void endTask(step.task, step.since, "gave-up")} data-testid="usability-self-gaveup">
                  {t("usabilitySelf.gaveUp")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {step.kind === "seq" && (
        <fieldset style={{ border: "none", padding: 0, margin: "8px 0" }}>
          <legend style={{ fontWeight: 600 }}>{SEQ_QUESTION[lang]}</legend>
          <div style={row}>
            <span style={{ fontSize: 12 }}>{SEQ_QUESTION.low[lang]}</span>
            {[1, 2, 3, 4, 5, 6, 7].map((v) => (
              <button key={v} type="button" className="btn" style={{ minInlineSize: 40, minBlockSize: 40 }} data-seq={v} onClick={() => answerSeq(step.task, v)}>
                {v}
              </button>
            ))}
            <span style={{ fontSize: 12 }}>{SEQ_QUESTION.high[lang]}</span>
          </div>
        </fieldset>
      )}

      {step.kind === "sus" && (
        <div>
          <p style={{ margin: "8px 0" }}>{t("usabilitySelf.sus.intro")}</p>
          <ol style={{ paddingInlineStart: 18, margin: 0 }}>
            {SUS_ITEMS.map((item, i) => (
              <li key={i} style={{ marginBlock: 8 }}>
                <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                  <legend>{item[lang]}</legend>
                  <div style={row}>
                    {SUS_SCALE[lang].map((label, k) => (
                      <label key={k} style={{ display: "inline-flex", gap: 3, alignItems: "center", fontSize: 12 }} title={label}>
                        <input type="radio" name={`sus-self-${i}`} checked={sus[i] === k + 1} onChange={() => setSusAnswers((a) => a.map((v, j) => (j === i ? k + 1 : v)))} aria-label={`${k + 1} — ${label}`} />
                        {k + 1}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "hsl(var(--fg-muted))" }}>
            <span>1 = {SUS_SCALE[lang][0]}</span>
            <span>5 = {SUS_SCALE[lang][4]}</span>
          </div>
          <button type="button" className="btn btn-primary" style={{ ...big, marginBlockStart: 8 }} disabled={sus.some((v) => v === 0)} onClick={finish} data-testid="usability-self-finish">
            {t("usabilitySelf.finish")}
          </button>
        </div>
      )}

      {step.kind === "done" && session && (
        <div>
          <p style={{ margin: "8px 0" }}>{t("usabilitySelf.thanks")}</p>
          <div style={row}>
            <button type="button" className="btn btn-primary" style={big} onClick={() => void save()} data-testid="usability-self-save">
              {t("usabilitySelf.save")}
            </button>
            <button type="button" className="btn" style={big} onClick={remove} data-testid="usability-self-delete">
              {t("usabilitySelf.delete")}
            </button>
          </div>
          <p style={{ margin: "8px 0", fontSize: 12 }}>{t("usabilitySelf.send")}</p>
        </div>
      )}

      {session && step.kind !== "done" && (
        <button type="button" className="btn" style={{ marginBlockStart: 10, fontSize: 12 }} onClick={stopNow} data-testid="usability-self-stop">
          {t("usabilitySelf.stop")}
        </button>
      )}
    </section>
  );
}
