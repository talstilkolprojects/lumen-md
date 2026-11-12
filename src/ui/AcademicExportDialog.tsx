/**
 * "Export for academic submission" (plan W5.16): pick the institution, check
 * the title page, export a Word file formatted to that institution's written
 * guideline (../storage/academicTemplates). The cover fields start from the
 * note's frontmatter (title, course, lecturer, author …), so a note that has
 * them exports in one click.
 *
 * Loaded on demand from the palette (`file.exportAcademic`):
 * `void import("./AcademicExportDialog").then((m) => m.openAcademicExport(doc))`.
 */

import "./academicStrings";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { GraduationCap, X } from "lucide-react";
import { t, getLocale } from "../i18n";
import { ACADEMIC_TEMPLATES, COVER_KEYS, academicTemplate, splitCover, type AcademicTemplateId, type CoverFields, type PageNumberFormat } from "../storage/academicTemplates";

const SETTINGS_KEY = "lumen.academicExport.v1";

interface Remembered {
  institution: AcademicTemplateId;
  author: string;
}

function loadRemembered(): Partial<Remembered> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Remembered>) : {};
  } catch {
    // why: storage blocked or corrupt — start from the defaults
    return {};
  }
}

function saveRemembered(r: Remembered): void {
  try {
    // The student ID is not remembered: it stays in the note or the form.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(r));
  } catch {
    /* why: storage blocked — the form just won't remember the institution */
  }
}

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const field: React.CSSProperties = { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };

const FRONT_FORMATS: PageNumberFormat[] = ["none", "hebrew1", "lowerRoman"];

export interface AcademicExportProps {
  content: string;
  name: string;
  onClose: () => void;
}

export function AcademicExportDialog({ content, name, onClose }: AcademicExportProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [initial] = useState(() => {
    const { cover, institution } = splitCover(content);
    const remembered = loadRemembered();
    const id = (academicTemplate(institution ?? "")?.id ?? remembered.institution ?? "huji") as AcademicTemplateId;
    return { id, cover: { ...cover, title: cover.title ?? name.replace(/\.[^.]+$/, ""), author: cover.author ?? remembered.author ?? "" } };
  });
  const [institution, setInstitution] = useState<AcademicTemplateId>(initial.id);
  const template = academicTemplate(institution) ?? ACADEMIC_TEMPLATES[0];
  const [cover, setCover] = useState<CoverFields>(initial.cover);
  const [front, setFront] = useState<PageNumberFormat>(template.frontNumbering);
  const [toc, setToc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const he = getLocale() === "he";

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (id: AcademicTemplateId) => {
    setInstitution(id);
    setFront(academicTemplate(id)?.frontNumbering ?? "none");
  };

  const exportNow = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { exportToDocx } = await import("../storage/exportDocx");
      await exportToDocx(content, name, { academic: { template, cover, frontNumbering: front, toc } });
      saveRemembered({ institution, author: cover.author ?? "" });
      setResult({ text: t("academic.done", { name: name.replace(/\.[^.]+$/, "") + ".docx" }), error: false });
    } catch (err) {
      setResult({ text: t("academic.failed", { error: err instanceof Error ? err.message : String(err) }), error: true });
    } finally {
      setBusy(false);
    }
  };

  const m = template.marginsCm;
  const summary = t("academic.summary", {
    font: template.hebrewFont,
    size: template.sizePt,
    spacing: template.lineSpacing,
    margins: `${m.right} / ${m.left} / ${m.top} / ${m.bottom}`,
  });

  return (
    <div className="cmd-palette-backdrop">
      <div className="cmd-palette" role="dialog" aria-modal="true" aria-label={t("academic.title")} data-testid="academic-export" style={{ maxWidth: 600, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <GraduationCap size={18} style={{ color: "hsl(var(--accent))" }} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("academic.title")}</h2>
          <button ref={closeRef} type="button" style={ghost} onClick={onClose} aria-label={t("academic.close")}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("academic.intro")}</p>

          <label style={col}>
            <span>{t("academic.institution")}</span>
            <select style={field} value={institution} onChange={(e) => pick(e.target.value as AcademicTemplateId)} data-testid="academic-institution">
              {ACADEMIC_TEMPLATES.map((x) => (
                <option key={x.id} value={x.id}>
                  {he ? x.institution.he : x.institution.en}
                </option>
              ))}
            </select>
            <span style={muted} data-testid="academic-summary">
              {(he ? template.scope.he : template.scope.en) + " · " + summary}{" "}
              <a href={template.source} target="_blank" rel="noreferrer">
                {t("academic.source")}
              </a>
            </span>
          </label>

          <fieldset style={{ border: "1px solid hsl(var(--border))", borderRadius: 6, padding: "8px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
            <legend>{t("academic.cover")}</legend>
            {COVER_KEYS.map((k) => (
              <label key={k} style={{ ...col, gridColumn: k === "title" ? "1 / -1" : undefined }}>
                <span>{t(`academic.field.${k}`)}</span>
                <input dir="auto" style={field} value={cover[k] ?? ""} onChange={(e) => setCover((c) => ({ ...c, [k]: e.target.value }))} data-testid={`academic-${k}`} />
              </label>
            ))}
          </fieldset>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={toc} onChange={(e) => setToc(e.target.checked)} data-testid="academic-toc" />
              <span>{t("academic.toc")}</span>
            </label>
            <label style={{ ...col, flex: 1 }}>
              <span>{t("academic.front")}</span>
              <select style={field} value={front} disabled={!toc} onChange={(e) => setFront(e.target.value as PageNumberFormat)} data-testid="academic-front">
                {FRONT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(`academic.front.${f}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {result && (
            <div role={result.error ? "alert" : "status"} style={{ fontSize: 13, color: result.error ? "hsl(0 70% 55%)" : undefined }} data-testid="academic-result">
              {result.text}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" style={primary} onClick={() => void exportNow()} disabled={busy} data-testid="academic-go">
              {t("academic.export")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

let openHost: { close: () => void } | null = null;

/** Open the academic export dialog for a note (one at a time). */
export function openAcademicExport(doc: { content: string; name: string }): void {
  openHost?.close();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (openHost?.close === close) openHost = null;
    try {
      root.unmount();
    } catch {
      /* why: already unmounted by an earlier close */
    }
    host.remove();
  };
  openHost = { close };
  root.render(<AcademicExportDialog content={doc.content} name={doc.name} onClose={close} />);
}
