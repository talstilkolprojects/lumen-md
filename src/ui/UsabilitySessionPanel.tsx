/**
 * The moderator's panel for a usability session (plan W1.29): consent and
 * participant code, then task markers, outcomes and observation codes, the
 * ease question after each task, SUS at the end, and the export. Opened
 * from the palette (*Usability study (moderator)…*); off until then, and
 * nothing is recorded before consent. See sessionRecorder.ts for what is
 * and isn't kept.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { getLocale, t } from "../i18n";
import { downloadText } from "../storage/exportFormats";
import { deleteSession, endSession, exportFile, listen, loadSession, NOTE_CODES, record, setSeq, setSus, startSession, validParticipant, type Outcome, type Session } from "../research/usability/sessionRecorder";
import { SEQ_QUESTION, SUS_ITEMS, SUS_SCALE, TASKS } from "../research/usability/study";
import { uiStrings } from "../research/usability/uiStrings";
import { version as appVersion } from "../../package.json";
import "./usabilitySessionPanelStrings";


const box: React.CSSProperties = { position: "fixed", insetBlockEnd: 12, insetInlineEnd: 12, zIndex: 80, inlineSize: "min(380px, calc(100vw - 24px))", maxBlockSize: "70vh", overflowY: "auto", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 10, boxShadow: "var(--shadow-md)", padding: 12, fontSize: 13 };
/** 24 px: the WCAG 2.2 minimum target (2.5.8), for the text-glyph buttons. */
const target: React.CSSProperties = { minInlineSize: 24, minBlockSize: 24, display: "inline-flex", alignItems: "center", justifyContent: "center" };
const row: React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBlock: 6 };

type View = "setup" | "tasks" | "sus" | "done";

export function UsabilitySessionPanel({ onClose }: { onClose: () => void }) {
  const lang = getLocale() === "he" ? "he" : "en";
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState<View>(() => (session ? (session.endedAt ? "done" : session.sus.length ? "done" : "tasks") : "setup"));
  const [collapsed, setCollapsed] = useState(false);
  const [code, setCode] = useState("");
  const [round, setRound] = useState(1);
  const [consent, setConsent] = useState(false);
  const [task, setTask] = useState(1);
  const [running, setRunning] = useState<number | null>(null);
  const [assisted, setAssisted] = useState(false);
  const [askSeq, setAskSeq] = useState<number | null>(null);
  const [sus, setSusAnswers] = useState<number[]>(Array(10).fill(0));
  const [, force] = useState(0);
  const strings = useMemo(() => uiStrings(), []);
  const stop = useRef<(() => void) | null>(null);

  // Listen while a session runs (also after a reload mid-session).
  useEffect(() => {
    if (!session || session.endedAt) return;
    stop.current = listen(session, strings);
    return () => {
      stop.current?.();
      stop.current = null;
    };
  }, [session, strings]);

  const app = (): Session["app"] => ({
    version: appVersion,
    locale: getLocale(),
    dir: document.documentElement.dir || "ltr",
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    touch: typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
  });

  const begin = () => {
    const s = startSession({ participant: code, round, consent, app: app() });
    setSession(s);
    setView("tasks");
  };
  const now = () => Date.now();
  const startTask = () => {
    if (!session) return;
    record(session, { t: now(), type: "task-start", task });
    setRunning(task);
    setAssisted(false);
    force((n) => n + 1);
  };
  const endTask = (outcome: Outcome) => {
    if (!session || running === null) return;
    record(session, { t: now(), type: "task-end", task: running, outcome, assisted });
    setAskSeq(running);
    setRunning(null);
    setTask(Math.min(TASKS.length, running + 1));
  };
  const note = (c: string) => session && record(session, { t: now(), type: "note", code: c });
  const finishTasks = () => setView("sus");
  const saveSus = () => {
    if (!session) return;
    setSus(session, sus);
    endSession(session);
    stop.current?.();
    setView("done");
  };
  const doExport = () => {
    if (!session) return;
    const f = exportFile(session);
    downloadText(f.name, f.text, "application/json");
  };
  const doDelete = () => {
    if (!window.confirm(t("usability.delete.confirm"))) return;
    stop.current?.();
    deleteSession();
    setSession(null);
    setView("setup");
    setCode("");
    setConsent(false);
    onClose();
  };

  if (collapsed) {
    return (
      <button type="button" data-usability-panel onClick={() => setCollapsed(false)} style={{ ...box, inlineSize: "auto", padding: "6px 10px", cursor: "pointer" }} aria-label={t("usability.expand")}>
        ● {running ? t("usability.taskRunning", { n: running }) : t("usability.title")}
      </button>
    );
  }

  return (
    <section data-usability-panel data-testid="usability-panel" aria-labelledby="usability-title" style={box}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <h2 id="usability-title" style={{ flex: 1, margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("usability.title")}
          {session && ` · ${session.participant} · ${t("usability.round", { n: session.round })}`}
        </h2>
        <button type="button" className="btn" style={target} onClick={() => setCollapsed(true)} aria-label={t("usability.collapse")}>
          –
        </button>
        {!session && (
          <button type="button" className="btn" style={target} onClick={onClose} aria-label={t("usability.close")}>
            ✕
          </button>
        )}
      </div>

      {view === "setup" && (
        <div>
          <p style={{ color: "hsl(var(--fg-muted))", margin: "6px 0" }}>{t("usability.setup.intro")}</p>
          <label style={row}>
            {t("usability.participant")}
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="P1" dir="ltr" style={{ inlineSize: 70 }} data-testid="usability-code" />
          </label>
          <label style={row}>
            {t("usability.roundLabel")}
            <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <label style={{ ...row, alignItems: "flex-start" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="usability-consent" />
            <span>{t("usability.consent")}</span>
          </label>
          <button type="button" className="btn" disabled={!consent || !validParticipant(code)} onClick={begin} data-testid="usability-start">
            {t("usability.start")}
          </button>
        </div>
      )}

      {view === "tasks" && session && (
        <div>
          {askSeq !== null ? (
            <fieldset style={{ border: "none", padding: 0, margin: "6px 0" }}>
              <legend style={{ fontWeight: 600 }}>{SEQ_QUESTION[lang]}</legend>
              <div style={row}>
                <span style={{ fontSize: 11 }}>{SEQ_QUESTION.low[lang]}</span>
                {[1, 2, 3, 4, 5, 6, 7].map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="btn"
                    data-seq={v}
                    onClick={() => {
                      setSeq(session, askSeq, v);
                      setAskSeq(null);
                    }}
                  >
                    {v}
                  </button>
                ))}
                <span style={{ fontSize: 11 }}>{SEQ_QUESTION.high[lang]}</span>
              </div>
            </fieldset>
          ) : running === null ? (
            <>
              <label style={row}>
                {t("usability.task")}
                <select value={task} onChange={(e) => setTask(Number(e.target.value))} data-testid="usability-task">
                  {TASKS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.id}. {x[lang]} {session.seq[x.id] ? "✓" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div style={row}>
                <button type="button" className="btn" onClick={startTask} data-testid="usability-task-start">
                  {t("usability.task.start", { n: task })}
                </button>
                <button type="button" className="btn" onClick={finishTasks}>
                  {t("usability.toSus")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ margin: "6px 0", fontWeight: 600 }}>
                {t("usability.taskRunning", { n: running })}: {TASKS[running - 1][lang]} · {t("usability.limit", { min: TASKS[running - 1].limitMin })}
              </p>
              <div style={row}>
                {(["success", "partial", "fail", "gave-up"] as const).map((o) => (
                  <button key={o} type="button" className="btn" data-outcome={o} onClick={() => endTask(o)}>
                    {t(`usability.outcome.${o}`)}
                  </button>
                ))}
              </div>
              <label style={row}>
                <input type="checkbox" checked={assisted} onChange={(e) => setAssisted(e.target.checked)} />
                {t("usability.assisted")}
              </label>
              <div style={row} aria-label={t("usability.notes")} role="group">
                {NOTE_CODES.map((c) => (
                  <button key={c} type="button" className="btn" style={{ fontSize: 11 }} onClick={() => note(c)}>
                    {t(`usability.note.${c}`)}
                  </button>
                ))}
              </div>
            </>
          )}
          <p style={{ fontSize: 11, color: "hsl(var(--fg-muted))", margin: "6px 0 0" }}>{t("usability.recording", { n: session.events.length })}</p>
        </div>
      )}

      {view === "sus" && session && (
        <div>
          <p style={{ margin: "6px 0", color: "hsl(var(--fg-muted))" }}>{t("usability.sus.intro")}</p>
          <ol style={{ paddingInlineStart: 18, margin: 0 }}>
            {SUS_ITEMS.map((item, i) => (
              <li key={i} style={{ marginBlock: 6 }}>
                <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                  <legend>{item[lang]}</legend>
                  <div style={row}>
                    {SUS_SCALE[lang].map((label, k) => (
                      <label key={k} style={{ display: "inline-flex", gap: 2, alignItems: "center", fontSize: 11 }} title={label}>
                        <input type="radio" name={`sus-${i}`} checked={sus[i] === k + 1} onChange={() => setSusAnswers((a) => a.map((v, j) => (j === i ? k + 1 : v)))} aria-label={`${k + 1} — ${label}`} />
                        {k + 1}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "hsl(var(--fg-muted))" }}>
            <span>1 = {SUS_SCALE[lang][0]}</span>
            <span>5 = {SUS_SCALE[lang][4]}</span>
          </div>
          <button type="button" className="btn" disabled={sus.some((v) => v === 0)} onClick={saveSus} data-testid="usability-sus-save" style={{ marginBlockStart: 8 }}>
            {t("usability.sus.save")}
          </button>
        </div>
      )}

      {view === "done" && session && (
        <div>
          <p style={{ margin: "6px 0" }}>{t("usability.done")}</p>
          <div style={row}>
            <button type="button" className="btn" onClick={doExport} data-testid="usability-export">
              {t("usability.export")}
            </button>
            <button type="button" className="btn" onClick={doDelete} data-testid="usability-delete">
              {t("usability.delete")}
            </button>
          </div>
          <p style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t("usability.retention")}</p>
        </div>
      )}
    </section>
  );
}
