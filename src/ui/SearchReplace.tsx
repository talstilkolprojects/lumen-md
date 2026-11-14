import { useState, useRef, useEffect, useCallback } from "react";
import { Search, Replace, X, ChevronDown, ChevronUp, CaseSensitive } from "lucide-react";
import { t } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current document content */
  content: string;
  /** Called when content changes from a replace operation */
  onChange: (newContent: string) => void;
}

export function SearchReplace({ open, onClose, content, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find all matches
  const matches = useMatches(content, query, isRegex, caseSensitive);
  const total = matches.length;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setCurrentIndex(0);
  }, [query, isRegex, caseSensitive]);

  const replaceOne = useCallback(() => {
    if (total === 0 || !matches[currentIndex]) return;
    const m = matches[currentIndex];
    const before = content.slice(0, m.start);
    const after = content.slice(m.end);
    onChange(before + replacement + after);
    // After replacing, keep index valid
    setCurrentIndex((i) => Math.min(i, Math.max(0, total - 2)));
  }, [content, matches, currentIndex, replacement, total, onChange]);

  const replaceAll = useCallback(() => {
    if (total === 0) return;
    let result = content;
    // Replace from end to start to preserve positions
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      result = result.slice(0, m.start) + replacement + result.slice(m.end);
    }
    onChange(result);
    setCurrentIndex(0);
  }, [content, matches, replacement, total, onChange]);

  const goPrev = () => setCurrentIndex((i) => (i - 1 + total) % total);
  const goNext = () => setCurrentIndex((i) => (i + 1) % total);

  if (!open) return null;

  return (
    <div
      data-testid="find-replace"
      style={{
        position: "absolute",
        top: 48,
        insetInlineEnd: 16,
        zIndex: 9998,
        background: "hsl(var(--bg))",
        border: "1px solid hsl(var(--border-strong))",
        borderRadius: 10,
        boxShadow: "0 12px 40px -8px hsl(0 0% 0% / 0.4)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 320,
        animation: "cmdSlideIn 120ms ease",
      }}
    >
      {/* Search row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Search size={13} style={{ color: "hsl(var(--fg-muted))", flexShrink: 0 }} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("findReplace.searchInput")}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") goNext();
          }}
          style={{
            flex: 1,
            background: "hsl(var(--bg-subtle))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 13,
            color: "hsl(var(--fg))",
            outline: "none",
          }}
        />
        <button onClick={() => setIsRegex(!isRegex)} title={t("findReplace.regex")} aria-label={t("findReplace.regex")} aria-pressed={isRegex} className="icon-btn"
          style={{ background: isRegex ? "hsl(var(--accent) / 0.15)" : "transparent", width: 28, height: 28 }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>.*</span>
        </button>
        <button onClick={() => setCaseSensitive(!caseSensitive)} title={t("findReplace.caseSensitive")} aria-label={t("findReplace.caseSensitive")} aria-pressed={caseSensitive} className="icon-btn"
          style={{ background: caseSensitive ? "hsl(var(--accent) / 0.15)" : "transparent", width: 28, height: 28 }}>
          <CaseSensitive size={13} />
        </button>
        <span aria-live="polite" style={{ fontSize: 11, color: "hsl(var(--fg-muted))", minWidth: 40, textAlign: "center" }}>
          {total > 0 ? `${currentIndex + 1}/${total}` : "0"}
        </span>
        <button onClick={goPrev} title={t("findReplace.prev")} aria-label={t("findReplace.prev")} className="icon-btn" style={{ width: 24, height: 24 }}><ChevronUp size={13} /></button>
        <button onClick={goNext} title={t("findReplace.next")} aria-label={t("findReplace.next")} className="icon-btn" style={{ width: 24, height: 24 }}><ChevronDown size={13} /></button>
        <button onClick={onClose} title={t("findReplace.close")} aria-label={t("findReplace.close")} className="icon-btn" style={{ width: 24, height: 24 }}><X size={13} /></button>
      </div>

      {/* Replace row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={() => setShowReplace(!showReplace)} className="icon-btn" style={{ width: 20, height: 20 }} title={t("findReplace.toggleReplace")} aria-label={t("findReplace.toggleReplace")} aria-pressed={showReplace}>
          <Replace size={13} />
        </button>
        {showReplace && (
          <>
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder={t("findReplace.replacePlaceholder")}
              aria-label={t("findReplace.replaceInput")}
              onKeyDown={(e) => { if (e.key === "Enter") replaceOne(); }}
              style={{
                flex: 1,
                background: "hsl(var(--bg-subtle))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 13,
                color: "hsl(var(--fg))",
                outline: "none",
              }}
            />
            <button onClick={replaceOne} className="icon-btn" title={t("findReplace.replace")}
              style={{ fontSize: 11, width: "auto", padding: "2px 8px" }}>
              {t("findReplace.replace")}
            </button>
            <button onClick={replaceAll} className="icon-btn" title={t("findReplace.replaceAll")}
              style={{ fontSize: 11, width: "auto", padding: "2px 8px" }}>
              {t("findReplace.replaceAll")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Find all match positions in content for the given query */
function useMatches(content: string, query: string, isRegex: boolean, caseSensitive: boolean) {
  if (!query) return [];
  try {
    const flags = caseSensitive ? "g" : "gi";
    const re = isRegex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
    const results: { start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      results.push({ start: m.index, end: m.index + m[0].length });
      if (results.length > 5000) break; // safety cap
    }
    return results;
  } catch {
    return [];
  }
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
