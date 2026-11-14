import { useMemo, useState } from "react";
import { BookOpen } from "lucide-react";
import { formatEntry, parseBibtex } from "../data/bibtex";
import {
  CITATION_STYLES,
  formatInText,
  formatReference,
  recordFromBibtex,
  runsToText,
  type CitationLang,
  type CitationStyle,
} from "../data/citationStyles";
import { getLocale, t } from "../i18n";

interface Props {
  source: string;
}

/**
 * `% style: mla` / `% lang: he` comment lines in the block pick the style
 * and the language of the terms (plan 6.13); otherwise APA, in the UI's
 * language when that is Hebrew.
 */
function directives(source: string): { style: CitationStyle; lang: CitationLang } {
  const style = /^\s*%\s*style\s*[:=]\s*(apa|chicago|mla)\b/im.exec(source)?.[1]?.toLowerCase() as CitationStyle | undefined;
  const lang = /^\s*%\s*lang\s*[:=]\s*(en|he)\b/im.exec(source)?.[1]?.toLowerCase() as CitationLang | undefined;
  return { style: style ?? "apa", lang: lang ?? (getLocale() === "he" ? "he" : "en") };
}

export default function BibtexBlock({ source }: Props) {
  const entries = useMemo(() => parseBibtex(source), [source]);
  const initial = useMemo(() => directives(source), [source]);
  const [picked, setPicked] = useState<CitationStyle | null>(null);
  const style = picked ?? initial.style;
  const lang = initial.lang;

  // Author-date lists are alphabetical: by the first author, then the year.
  const items = useMemo(() => {
    const withRecord = entries.map((entry) => ({ entry, record: recordFromBibtex(entry) }));
    const sortKey = (r: (typeof withRecord)[number]) => `${r.record.authors[0]?.family ?? r.record.title.replace(/[{}]/g, "")} ${r.record.year ?? ""}`;
    return withRecord.sort((a, b) => sortKey(a).localeCompare(sortKey(b), lang));
  }, [entries, lang]);

  if (entries.length === 0) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          ⚠︎ {t("bibtex.noEntries")}
        </div>
      </div>
    );
  }

  return (
    <div className="chart-block bibliography" dir={lang === "he" ? "rtl" : undefined}>
      <div className="chart-block-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: 1 }}>
          <BookOpen size={13} style={{ opacity: 0.7 }} />
          {t("bibtex.references", { n: entries.length })}
        </span>
        <select
          aria-label={t("bibtex.style")}
          value={style}
          onChange={(e) => setPicked(e.target.value as CitationStyle)}
          style={{ fontSize: 12, padding: "2px 6px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg-subtle))", color: "hsl(var(--fg))" }}
        >
          {CITATION_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <ul className="bibliography-list" data-style={style} style={{ listStyle: "none", paddingInlineStart: 0 }}>
        {items.map(({ entry, record }) => {
          const runs = formatReference(record, style, lang);
          return (
            <li
              key={entry.key}
              id={`cite-${entry.key}`}
              className="bibliography-item"
              // Hanging indent, as every author-date list has.
              style={{ paddingInlineStart: "2em", textIndent: "-2em" }}
              title={formatInText(record, style, lang)}
              // Names, titles and DOIs are mostly Latin script: each reference keeps its own direction.
              dir="auto"
            >
              <span className="bibliography-text">
                {runs.map((r, i) => (r.i ? <em key={i}>{r.t}</em> : <span key={i}>{linkify(r.t)}</span>))}
              </span>
            </li>
          );
        })}
      </ul>
      {/* Plain text of the list, for quick copy */}
      <noscript title={items.map(({ record }) => runsToText(formatReference(record, style, lang))).join("\n") || entries.map((e, i) => formatEntry(e, i + 1)).join("\n")} />
    </div>
  );
}

/** A DOI / URL at the end of a reference becomes a link. */
function linkify(text: string) {
  const m = /(https?:\/\/\S+?)(\.?)$/.exec(text);
  if (!m) return text;
  return (
    <>
      {text.slice(0, m.index)}
      <a href={m[1]} target="_blank" rel="noopener noreferrer">
        {m[1]}
      </a>
      {m[2]}
    </>
  );
}
