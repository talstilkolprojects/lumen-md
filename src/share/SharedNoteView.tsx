/**
 * The read-only viewer of an encrypted share link (plan W5.10). The app
 * renders it instead of the editor when the page opens with `#view=…` or
 * `#view-file…` (src/main.tsx). The note is decrypted here, on this
 * device, from the link's #fragment (src/share/linkShare.ts): it is never
 * saved into the vault, and no account is needed.
 *
 * A link without its key asks for the key; `#view-file` asks for the
 * encrypted file. Rendering is the preview's own pipeline, so images from
 * other sites stay behind the usual placeholder (plan 2.2).
 */
import "./shareStrings";
import { useEffect, useState, type ReactElement } from "react";
import { t, getLocale } from "../i18n";
import { fromBase64Url, openNote, parseShareHash, shareFileData, ShareLinkError, type ShareError, type SharedNote } from "./linkShare";

const field: React.CSSProperties = { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };

type State =
  | { step: "key"; data: Uint8Array | null }
  | { step: "file"; key: string }
  | { step: "opening" }
  | { step: "error"; code: ShareError }
  | { step: "shown"; note: SharedNote; tree: ReactElement };

const errorText = (code: ShareError): string =>
  ({
    malformed: t("shareLink.view.error.malformed"),
    key: t("shareLink.view.error.key"),
    expired: t("shareLink.view.error.expired"),
    unsupported: t("shareLink.unsupported"),
  })[code];

async function render(note: SharedNote): Promise<ReactElement> {
  try {
    const { renderMarkdown } = await import("../renderer/pipeline");
    return await renderMarkdown(note.markdown, () => document.documentElement.classList.contains("dark"));
  } catch {
    // why: the renderer chunk could not load (offline after an update): the text itself, unrendered
    return (
      <pre dir="auto" style={{ whiteSpace: "pre-wrap" }} data-testid="shared-note-plain">
        {note.markdown}
      </pre>
    );
  }
}

function initial(hash: string): State {
  const parsed = parseShareHash(hash);
  if (!parsed) return { step: "error", code: "malformed" };
  if (parsed.data === null) return parsed.key ? { step: "file", key: parsed.key } : { step: "error", code: "malformed" };
  if (!parsed.key) {
    try {
      return { step: "key", data: fromBase64Url(parsed.data) };
    } catch {
      return { step: "error", code: "malformed" };
    }
  }
  return { step: "opening" };
}

export default function SharedNoteView() {
  const [state, setState] = useState<State>(() => initial(location.hash));
  const [keyInput, setKeyInput] = useState("");

  const show = async (data: Uint8Array, key: string) => {
    setState({ step: "opening" });
    try {
      const note = await openNote(data, fromBase64Url(key.trim()));
      setState({ step: "shown", note, tree: await render(note) });
      document.title = `${note.title} · Lumen`;
    } catch (e) {
      setState({ step: "error", code: e instanceof ShareLinkError ? e.code : "malformed" });
    }
  };

  useEffect(() => {
    if (state.step !== "opening") return;
    const parsed = parseShareHash(location.hash);
    if (!parsed?.data || !parsed.key) return;
    let data: Uint8Array;
    try {
      data = fromBase64Url(parsed.data);
    } catch {
      setState({ step: "error", code: "malformed" });
      return;
    }
    void show(data, parsed.key);
    // Once, on mount: a later #fragment change reloads the page (src/main.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const date = (ms: number) => new Date(ms).toLocaleString(getLocale());

  return (
    <div style={{ minHeight: "100vh", background: "hsl(var(--bg))", color: "hsl(var(--fg))" }} data-testid="shared-note">
      <header style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
        <strong style={{ fontSize: 14 }}>Lumen</strong>
        <span style={muted} data-testid="shared-note-badge">{t("shareLink.view.badge")}</span>
        <span style={{ flex: 1 }} />
        {state.step === "shown" && (
          <>
            <button type="button" style={ghost} onClick={() => void navigator.clipboard?.writeText(state.note.markdown).catch(() => { /* why: clipboard denied: the download keeps the text */ })}>
              {t("shareLink.view.copy")}
            </button>
            <button
              type="button"
              style={ghost}
              onClick={() => {
                const url = URL.createObjectURL(new Blob([state.note.markdown], { type: "text/markdown" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = /\.md$/i.test(state.note.title) ? state.note.title : `${state.note.title || "note"}.md`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
              }}
            >
              {t("shareLink.view.download")}
            </button>
          </>
        )}
        <a href="/" style={{ ...ghost, textDecoration: "none" }}>{t("shareLink.view.openApp")}</a>
      </header>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "16px" }}>
        {state.step === "opening" && <p style={muted} aria-live="polite">{t("shareLink.view.decrypting")}</p>}
        {state.step === "error" && (
          <p role="alert" style={{ fontSize: 14 }} data-testid="shared-note-error" data-code={state.code}>
            {errorText(state.code)}
          </p>
        )}
        {state.step === "key" && (
          <form
            style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (state.data) void show(state.data, keyInput);
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>{t("shareLink.view.needKey")}</span>
              <input dir="ltr" autoComplete="off" style={field} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} aria-label={t("shareLink.view.keyLabel")} data-testid="shared-note-key" />
            </label>
            <div>
              <button type="submit" style={ghost} disabled={!keyInput.trim()}>
                {t("shareLink.view.open")}
              </button>
            </div>
          </form>
        )}
        {state.step === "file" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
            <span>{t("shareLink.view.needFile")}</span>
            <input
              type="file"
              accept=".lumenshare,application/octet-stream"
              data-testid="shared-note-file"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (!f) return;
                const key = state.key;
                void f.arrayBuffer().then((buf) => {
                  const data = shareFileData(new Uint8Array(buf));
                  if (!data) setState({ step: "error", code: "malformed" });
                  else void show(data, key);
                });
              }}
            />
          </label>
        )}
        {state.step === "shown" && (
          <article>
            <p style={{ ...muted, margin: "0 0 12px" }} data-testid="shared-note-meta">
              <span dir="auto">{state.note.title}</span>
              {" · "}
              {t("shareLink.view.created", { date: date(state.note.created) })}
              {state.note.expires !== undefined && <> · {t("shareLink.view.expires", { date: date(state.note.expires) })}</>}
            </p>
            <div className="prose-lumen" dir="auto">
              {state.tree}
            </div>
          </article>
        )}
      </main>
    </div>
  );
}
