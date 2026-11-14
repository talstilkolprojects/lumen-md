/**
 * The legal citation picker (plan W5.2): a ruling, a law, regulations, a
 * bill, a book or a law-review article, written by כללי האזכור האחיד (3rd
 * edition, 2021) as you fill it in, and inserted at the cursor. Opened from
 * the palette, empty, or from a case number in the note ("ע"א 1234/05"), with
 * the proceeding, the court and the number already filled. Lazy-loaded.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import "./strings";
import { t } from "../i18n";
import { formatLegal, hebrewYearOfDate, type LegalSource, type RulingSource } from "./legal";
import { HelpButton } from "../ui/HelpButton";

type Kind = LegalSource["kind"];
const KINDS: Kind[] = ["ruling", "law", "regulation", "bill", "book", "article"];

/** The form's fields per kind, in order: [field, label key]. */
const FIELDS: Record<Kind, string[]> = {
  ruling: ["proceeding", "court", "number", "partyA", "partyB", "series", "volume", "page", "year", "database", "date", "paras", "judge"],
  law: ["name", "section", "hebrewYear", "year", "collectionYear", "page", "pinpointPage"],
  regulation: ["name", "section", "hebrewYear", "year", "collectionYear", "page", "pinpointPage"],
  bill: ["name", "hebrewYear", "year", "collection", "page", "pinpointPage"],
  book: ["authors", "title", "volume", "pinpoint", "edition", "editor", "translator", "year"],
  article: ["authors", "title", "journal", "volume", "issue", "page", "pinpoint", "year"],
};

type Values = Record<string, string>;

/** The form's values as a source (empty fields left out). */
export function sourceOf(kind: Kind, v: Values): LegalSource {
  const f = (k: string) => v[k]?.trim() || undefined;
  // why: authors are separated by commas only — a leading ו is part of names like ויסמן
  const names = (k: string) => (v[k] ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  switch (kind) {
    case "ruling":
      return {
        kind,
        proceeding: f("proceeding") ?? "",
        court: f("court"),
        number: f("number") ?? "",
        parties: [f("partyA") ?? "", f("partyB") ?? ""],
        reporter: f("series") ? { series: f("series")!, volume: f("volume") ?? "", page: f("page") ?? "" } : undefined,
        database: f("series") ? undefined : { name: f("database") ?? "נבו", date: f("date") ?? "" },
        year: f("year"),
        pinpoint: f("paras") ? { paras: f("paras")!, judge: f("judge") } : undefined,
      };
    case "book":
      return { kind, authors: names("authors"), title: f("title") ?? "", volume: f("volume"), pinpoint: f("pinpoint"), edition: f("edition"), editor: f("editor"), translator: f("translator"), year: f("year") ?? "" };
    case "article":
      return { kind, authors: names("authors"), title: f("title") ?? "", journal: f("journal") ?? "", volume: f("volume") ?? "", issue: f("issue"), page: f("page") ?? "", pinpoint: f("pinpoint"), year: f("year") ?? "" };
    default:
      return { kind, name: f("name") ?? "", section: f("section"), hebrewYear: f("hebrewYear"), year: f("year"), collection: f("collection"), collectionYear: f("collectionYear"), page: f("page") ?? "", pinpointPage: f("pinpointPage") };
  }
}

/** The form's starting values for a ruling found in the text. */
export function valuesOf(r: RulingSource): Values {
  return { proceeding: r.proceeding, court: r.court ?? "", number: r.number, partyA: r.parties[0], partyB: r.parties[1], database: r.database?.name ?? "נבו", date: r.database?.date ?? "" };
}

const input: CSSProperties = { inlineSize: "100%", padding: "3px 6px", border: "1px solid hsl(var(--border))", borderRadius: 5, background: "hsl(var(--bg))", color: "hsl(var(--fg))", fontSize: 13 };
const btn: CSSProperties = { border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 12px", background: "transparent", color: "inherit", cursor: "pointer" };

export function LegalCiteDialog({ initial, onInsert, onClose }: { initial?: { kind: Kind; values: Values }; onInsert: (text: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "ruling");
  const [values, setValues] = useState<Values>(initial?.values ?? { database: "נבו" });
  const text = useMemo(() => formatLegal(sourceOf(kind, values)), [kind, values]);
  const set = (k: string, v: string) =>
    setValues((old) => {
      const next = { ...old, [k]: v };
      // The Hebrew year of a law from its date, when the person types one ("1997-03-05").
      if (k === "year" && /^\d{4}-\d{2}-\d{2}$/.test(v) && kind !== "ruling" && !old.hebrewYear) {
        next.hebrewYear = hebrewYearOfDate(v) ?? "";
        next.year = v.slice(0, 4);
      }
      return next;
    });
  return (
    <div role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={t("legalCite.title")} data-testid="legal-cite" dir="rtl" lang="he" onKeyDown={(e) => e.key === "Escape" && onClose()} style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: 16, inlineSize: "min(560px, 100%)", maxBlockSize: "85vh", overflow: "auto", fontSize: 13 }}>
        <h2 style={{ marginBlockStart: 0, fontSize: 16 }}>{t("legalCite.title")}</h2>
        <HelpButton topic="editor/legal-citations" />
        <label style={{ display: "grid", gap: 2, marginBlockEnd: 8 }}>
          <span>{t("legalCite.kind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={input} data-testid="legal-kind" autoFocus>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`legalCite.kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
          {FIELDS[kind].map((k) => (
            <label key={k} style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t(`legalCite.f.${k}`)}</span>
              <input dir="auto" value={values[k] ?? ""} onChange={(e) => set(k, e.target.value)} style={input} data-field={k} />
            </label>
          ))}
        </div>
        <p style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t(`legalCite.hint.${kind === "regulation" || kind === "bill" ? "law" : kind}`)}</p>
        <output data-testid="legal-preview" dir="rtl" style={{ display: "block", padding: 8, borderRadius: 6, background: "hsl(var(--bg-subtle, 0 0% 50% / 0.08))", minBlockSize: 20 }}>
          {text}
        </output>
        <p style={{ fontSize: 10, color: "hsl(var(--fg-muted))" }}>{t("legalCite.rules")}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={btn} onClick={onClose}>
            {t("legalCite.cancel")}
          </button>
          <button type="button" style={{ ...btn, fontWeight: 600 }} data-testid="legal-insert" onClick={() => (onInsert(text), onClose())}>
            {t("legalCite.insert")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Open the picker; `initial`: a ruling found in the note. Inserts at the cursor (the editor's insert event). */
export function openLegalCiteDialog(initial?: RulingSource): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(
    <LegalCiteDialog
      initial={initial ? { kind: "ruling", values: valuesOf(initial) } : undefined}
      onInsert={(text) => window.dispatchEvent(new CustomEvent("lumen-mobile-insert", { detail: { insert: text, cursorOffset: 0 } }))}
      onClose={close}
    />,
  );
}
