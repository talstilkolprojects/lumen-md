/**
 * Named versions in a shared note (W3.11): save the current text under a
 * name, and compare any two versions (or a version and the current text)
 * word by word. The list lives in the shared document, so everyone in the
 * room sees it; only editors can add to it.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { History, X } from "lucide-react";
import type { CollabSession } from "../collab/yjs";
import { addVersion, compareVersions, listVersions, versionList, type NamedVersion } from "../collab/namedVersions";
import { getLocale, t } from "../i18n";
import "../collab/versionStrings";
import { toast } from "../store/useToastStore";
import { HelpButton } from "./HelpButton";

const CURRENT = "__current__";
const field: React.CSSProperties = { padding: "6px 8px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" };

function useVersions(session: CollabSession): NamedVersion[] {
  const list = useMemo(() => versionList(session.doc), [session]);
  const subscribe = (cb: () => void) => {
    list.observe(cb);
    return () => list.unobserve(cb);
  };
  // A new array only when the list changes (the snapshot must be stable).
  const snap = useMemo(() => ({ key: -1, value: [] as NamedVersion[] }), []);
  return useSyncExternalStore(subscribe, () => {
    const n = list.toArray().length;
    if (snap.key !== n) {
      snap.key = n;
      snap.value = listVersions(list);
    }
    return snap.value;
  });
}

function useText(session: CollabSession): string {
  const [text, setText] = useState(() => session.ytext.toString());
  useEffect(() => {
    const on = () => setText(session.ytext.toString());
    session.ytext.observe(on);
    return () => session.ytext.unobserve(on);
  }, [session]);
  return text;
}

export function NamedVersionsDialog({ session, author, onClose }: { session: CollabSession; author: string | null; onClose: () => void }) {
  const versions = useVersions(session);
  const text = useText(session);
  const [name, setName] = useState("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>(CURRENT);
  const canSave = session.role() === "edit";
  const fmt = useMemo(() => new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!from && versions[0]) setFrom(versions[0].id);
  }, [versions, from]);

  const textOf = (id: string) => (id === CURRENT ? text : (versions.find((v) => v.id === id)?.text ?? ""));
  const cmp = useMemo(() => (from ? compareVersions(textOf(from), textOf(to)) : null), [from, to, text, versions]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    const v = addVersion(versionList(session.doc), name, text, author);
    if (v) {
      toast.info(t("versions.saved", { name: v.name }));
      setName("");
    }
  };

  const options = [
    ...versions.map((v) => (
      <option key={v.id} value={v.id}>
        {v.name}
      </option>
    )),
    <option key={CURRENT} value={CURRENT}>
      {t("versions.current")}
    </option>,
  ];

  return (
    <div className="cmd-palette-backdrop" onClick={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="versions-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 720, maxHeight: "86vh", display: "flex", flexDirection: "column" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
          <History size={16} aria-hidden="true" />
          <h2 id="versions-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("versions.title")}
          </h2>
          <HelpButton topic="collab/suggestions-versions#named-versions" />
          <button type="button" onClick={onClose} aria-label={t("versions.close")} style={{ marginInlineStart: "auto", border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ overflow: "auto", padding: "12px 16px", display: "grid", gap: 12 }}>
          {canSave ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
              style={{ display: "flex", gap: 8 }}
            >
              <label style={{ flex: 1, display: "grid", gap: 4 }}>
                <span style={{ fontSize: 12 }}>{t("versions.name")}</span>
                <input dir="auto" value={name} maxLength={80} placeholder={t("versions.namePlaceholder")} onChange={(e) => setName(e.target.value)} style={field} />
              </label>
              <button type="submit" disabled={!name.trim()} style={{ ...field, alignSelf: "end", cursor: "pointer" }}>
                {t("versions.save")}
              </button>
            </form>
          ) : (
            <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t("versions.editorsOnly")}</p>
          )}
          {versions.length === 0 ? (
            // empty-action: the "name this version" field and Save above
            <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t("versions.empty")}</p>
          ) : (
            <>
              <ul data-testid="named-versions" style={{ margin: 0, paddingInlineStart: 18, fontSize: 13 }}>
                {versions.map((v) => (
                  <li key={v.id} dir="auto">
                    <strong>{v.name}</strong> — {t("versions.by", { author: v.author ?? t("versions.unknownAuthor"), date: fmt.format(v.at) })}
                  </li>
                ))}
              </ul>
              <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
                <legend style={{ fontSize: 12, marginBottom: 4 }}>{t("versions.compare")}</legend>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 12 }}>{t("versions.from")}</span>
                  <select value={from} onChange={(e) => setFrom(e.target.value)} style={field}>
                    {options}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 12 }}>{t("versions.to")}</span>
                  <select value={to} onChange={(e) => setTo(e.target.value)} style={field}>
                    {options}
                  </select>
                </label>
              </fieldset>
              {cmp && (
                <div>
                  <p style={{ margin: "0 0 6px", fontSize: 12, opacity: 0.8 }}>
                    {cmp.added || cmp.removed ? t("versions.stats", { added: cmp.added, removed: cmp.removed }) : t("versions.same")}
                  </p>
                  <div data-testid="version-diff" className="version-diff" dir="auto" style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6, padding: 10, border: "1px solid hsl(var(--border))", borderRadius: 6 }}>
                    {cmp.ops.map((op, i) =>
                      op.type === "equal" ? (
                        <span key={i}>{op.text}</span>
                      ) : op.type === "insert" ? (
                        <ins key={i} className="critic-ins">{op.text}</ins>
                      ) : (
                        <del key={i} className="critic-del">{op.text}</del>
                      ),
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function openNamedVersionsDialog(opts: { session: CollabSession; author: string | null }): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    try {
      root.unmount();
    } catch {
      // why: the dialog root is already unmounted
      /* already gone */
    }
    host.remove();
  };
  root.render(<NamedVersionsDialog session={opts.session} author={opts.author} onClose={close} />);
}
