/**
 * The private classroom (plan W5.21): one panel for both sides.
 *
 * - Teacher: "New assignment from the open note" makes the assignment's key
 *   pair and drop box and shows the link for the class. Per assignment:
 *   the submissions (opened on this device only), each one into a tab, and a
 *   comment sealed to that student; "Delete from the relay" at the end.
 * - Student: opening the link offers "Get my copy" (the template in a new
 *   tab, nothing sent); later "Hand in the open note" seals the note as it
 *   is to the teacher, and "Get comments" adds the teacher's comments to it.
 *
 * Loaded on use (launch.ts → open.tsx); the logic is in classroom.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { getLocale, t } from "../../../i18n";
import "../strings";
import { useAppStore } from "../../../store/useStore";
import { relayOrigin } from "../providers/relay";
import {
  closeAssignment,
  createAssignment,
  fetchComments,
  fetchSubmissions,
  joinAssignment,
  linkOf,
  sendComment,
  submit,
  type Assignment,
  type ClassComment,
  type ClassDeps,
  type StudentAssignment,
  type Submission,
  type TeacherAssignment,
} from "./classroom";
import { classLinkHash, ClassLinkError, type ClassLink } from "./link";
import { listAssignments, removeAssignment, saveAssignment } from "./store";

const muted: React.CSSProperties = { fontSize: 13, color: "hsl(var(--fg-muted))" };
const errorStyle: React.CSSProperties = { fontSize: 13, color: "hsl(var(--danger))" };
const field: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "8px 10px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "white" };
const card: React.CSSProperties = { border: "1px solid hsl(var(--border))", borderRadius: 8, padding: 12, display: "grid", gap: 8 };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };

/** This build's relay origin (the same setting as the encrypted sync's relay). */
export function buildRelay(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return relayOrigin(env?.VITE_SYNC_RELAY_URL);
}

const when = (ms: number) => new Date(ms).toLocaleString(getLocale());

/** The teacher's comments as a Markdown block at the end of the student's note. */
export function commentsMarkdown(comments: readonly ClassComment[]): string {
  return comments
    .map((c) => `\n\n> [!note] ${t("e2ee.class.commentHeading", { date: when(c.at) })}\n${c.text.split("\n").map((l) => `> ${l}`).join("\n")}`)
    .join("");
}

function errorText(e: unknown): string {
  if (e instanceof ClassLinkError) return t(`e2ee.class.error.link.${e.code}`);
  if (e instanceof RangeError) return t("e2ee.class.error.tooLong");
  return t("e2ee.class.error.relay", { error: e instanceof Error ? e.message : String(e) });
}

function TeacherCard({ a, deps, onError, onRemoved }: { a: TeacherAssignment; deps: ClassDeps; onError: (e: unknown) => void; onRemoved: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [unreadable, setUnreadable] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void classLinkHash(linkOf(a)).then((h) => setLink(`${location.origin}/${h}`), onError);
  }, [a, onError]);

  const load = async () => {
    setBusy(true);
    try {
      const got = await fetchSubmissions(a, deps);
      setSubs(got.submissions);
      setUnreadable(got.unreadable);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const comment = async (s: Submission) => {
    const text = (drafts[s.object] ?? "").trim();
    if (!text) return;
    try {
      await sendComment(a, s, text, deps);
      setSent({ ...sent, [s.object]: true });
      setDrafts({ ...drafts, [s.object]: "" });
    } catch (e) {
      onError(e);
    }
  };

  const close = async () => {
    const { uiConfirm } = await import("../../../ui/PromptDialog");
    if (!(await uiConfirm({ message: t("e2ee.class.closeConfirm", { title: a.title }) }))) return;
    try {
      await closeAssignment(a, deps);
      await removeAssignment(a);
      onRemoved();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <li style={card} data-testid="class-teacher-assignment">
      <strong dir="auto">{a.title}</strong>
      {link && (
        <div style={row}>
          <input readOnly dir="ltr" style={{ ...field, flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={link} aria-label={t("e2ee.class.link")} data-testid="class-link" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" style={ghost} onClick={() => void navigator.clipboard?.writeText(link).catch(() => undefined)}>
            {t("e2ee.class.copy")}
          </button>
        </div>
      )}
      <div style={muted}>{t("e2ee.class.linkNote")}</div>
      <div style={row}>
        <button type="button" style={primary} disabled={busy} onClick={() => void load()} data-testid="class-check">
          {t("e2ee.class.check")}
        </button>
        <button type="button" style={ghost} onClick={() => void close()}>
          {t("e2ee.class.close")}
        </button>
      </div>
      {subs && (
        <>
          <div role="status" style={muted}>
            {t("e2ee.class.received", { n: subs.length })}
            {unreadable > 0 ? ` · ${t("e2ee.class.unreadable", { n: unreadable })}` : ""}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} data-testid="class-submissions">
            {subs.map((s) => (
              <li key={s.object} style={{ ...card, padding: 8 }}>
                <div style={row}>
                  <strong dir="auto">{s.name || t("e2ee.class.noName")}</strong>
                  <span style={muted}>{t("e2ee.class.version", { n: s.version, date: when(s.at) })}</span>
                  <button type="button" style={ghost} onClick={() => useAppStore.getState().openTab({ name: `${s.name || "student"} — ${s.title}.md`, content: s.markdown })}>
                    {t("e2ee.class.openTab")}
                  </button>
                </div>
                <textarea
                  style={{ ...field, minHeight: 56 }}
                  dir="auto"
                  value={drafts[s.object] ?? ""}
                  onChange={(e) => setDrafts({ ...drafts, [s.object]: e.target.value })}
                  aria-label={t("e2ee.class.commentLabel", { name: s.name })}
                />
                <div style={row}>
                  <button type="button" style={ghost} onClick={() => void comment(s)}>
                    {t("e2ee.class.sendComment")}
                  </button>
                  {sent[s.object] && <span role="status" style={muted}>{t("e2ee.class.commentSent")}</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </li>
  );
}

function StudentCard({ a, deps, onError, onChange }: { a: StudentAssignment; deps: ClassDeps; onError: (e: unknown) => void; onChange: (a: StudentAssignment) => void }) {
  const docName = useAppStore((s) => s.doc.name);
  const [busy, setBusy] = useState(false);
  const [news, setNews] = useState<string | null>(null);
  const last = a.sent.at(-1);

  const handIn = async () => {
    // Snapshot the note before any await: a tab switch meanwhile must not hand in another note.
    const markdown = useAppStore.getState().doc.content;
    setBusy(true);
    try {
      const next = await submit(a, markdown, deps);
      await saveAssignment(next);
      onChange(next);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const getComments = async () => {
    setBusy(true);
    try {
      const comments = await fetchComments(a, deps);
      const st = useAppStore.getState();
      const fresh = comments.filter((c) => !st.doc.content.includes(c.text));
      if (fresh.length) st.setContent(st.doc.content + commentsMarkdown(fresh));
      setNews(t("e2ee.class.commentsAdded", { n: fresh.length }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li style={card} data-testid="class-student-assignment">
      <strong dir="auto">{a.title}</strong>
      <div style={muted}>{last ? t("e2ee.class.handedIn", { n: last.version, date: when(last.at) }) : t("e2ee.class.notHandedIn")}</div>
      <div style={row}>
        <button type="button" style={primary} disabled={busy} onClick={() => void handIn()} data-testid="class-hand-in">
          {t("e2ee.class.handIn", { name: docName })}
        </button>
        <button type="button" style={ghost} disabled={busy} onClick={() => void getComments()} data-testid="class-get-comments">
          {t("e2ee.class.getComments")}
        </button>
      </div>
      {news && <div role="status" style={muted}>{news}</div>}
    </li>
  );
}

export function ClassroomPanel({ onClose, joining = null, deps = {}, relay = buildRelay() }: { onClose: () => void; joining?: ClassLink | null; deps?: ClassDeps; relay?: string | null }) {
  const [list, setList] = useState<Assignment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(() => useAppStore.getState().doc.name.replace(/\.md$/i, ""));
  const [name, setName] = useState("");
  const [invite, setInvite] = useState<ClassLink | null>(joining);
  const onError = useCallback((e: unknown) => setError(errorText(e)), []);
  const reload = useCallback(() => void listAssignments().then(setList, onError), [onError]);
  useEffect(reload, [reload]);

  const create = async () => {
    if (!relay) return;
    setError(null);
    try {
      const { assignment } = await createAssignment({ title: title.trim() || t("e2ee.class.untitled"), template: useAppStore.getState().doc.content, relay }, deps);
      // Check the link fits before keeping the assignment.
      await classLinkHash(linkOf(assignment));
      await saveAssignment(assignment);
      reload();
    } catch (e) {
      onError(e);
    }
  };

  const join = async () => {
    if (!invite) return;
    setError(null);
    try {
      const existing = list.find((a) => a.role === "student" && a.id === invite.drop);
      if (!existing) await saveAssignment(await joinAssignment(invite, name, deps));
      useAppStore.getState().openTab({ name: `${invite.title}.md`, content: invite.template });
      setInvite(null);
      reload();
    } catch (e) {
      onError(e);
    }
  };

  const teacher = list.filter((a): a is TeacherAssignment => a.role === "teacher");
  const student = list.filter((a): a is StudentAssignment => a.role === "student");
  const otherRelay = invite !== null && invite.relay !== relay;

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "grid", placeItems: "center", zIndex: 1000 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="classroom-title"
        dir={getLocale() === "he" || getLocale() === "ar" ? "rtl" : "ltr"}
        data-testid="classroom"
        style={{ width: "min(620px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflow: "auto", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 12, padding: 20, display: "grid", gap: 14 }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="classroom-title" style={{ margin: 0, fontSize: 18 }}>
            {t("e2ee.class.title")}
          </h2>
          <button type="button" aria-label={t("e2ee.sync.close")} onClick={onClose} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 20 }}>
            ×
          </button>
        </div>
        <div style={muted}>{t("e2ee.class.intro")}</div>

        {invite && (
          <section style={card} data-testid="class-join">
            <strong dir="auto">{t("e2ee.class.joinTitle", { title: invite.title })}</strong>
            {otherRelay ? (
              <div role="alert" style={errorStyle}>
                {t("e2ee.class.otherRelay", { relay: invite.relay })}
              </div>
            ) : (
              <>
                <label style={{ display: "grid", gap: 4, fontSize: 14 }}>
                  {t("e2ee.class.yourName")}
                  <input style={field} value={name} onChange={(e) => setName(e.target.value)} dir="auto" autoComplete="name" data-testid="class-name" />
                </label>
                <div style={muted}>{t("e2ee.class.joinNote")}</div>
                <button type="button" style={{ ...primary, justifySelf: "start" }} disabled={!name.trim()} onClick={() => void join()} data-testid="class-join-go">
                  {t("e2ee.class.getCopy")}
                </button>
              </>
            )}
          </section>
        )}

        <section style={{ display: "grid", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{t("e2ee.class.teach")}</h3>
          {relay ? (
            <div style={row}>
              <input style={{ ...field, flex: 1, minWidth: 160 }} value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" aria-label={t("e2ee.class.assignmentTitle")} data-testid="class-title" />
              <button type="button" style={primary} onClick={() => void create()} data-testid="class-create">
                {t("e2ee.class.create")}
              </button>
            </div>
          ) : (
            <div style={muted}>{t("e2ee.class.noRelay")}</div>
          )}
          {teacher.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {teacher.map((a) => (
                <TeacherCard key={a.id} a={a} deps={deps} onError={onError} onRemoved={reload} />
              ))}
            </ul>
          )}
        </section>

        {student.length > 0 && (
          <section style={{ display: "grid", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{t("e2ee.class.learn")}</h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {student.map((a) => (
                <StudentCard key={a.id} a={a} deps={deps} onError={onError} onChange={reload} />
              ))}
            </ul>
          </section>
        )}

        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
