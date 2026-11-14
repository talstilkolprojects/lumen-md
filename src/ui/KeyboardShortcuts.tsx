import { useEffect, useMemo, useRef } from "react";
import { t } from "../i18n";
import { detectIsMac } from "../lib/detectIsMac";

export { detectIsMac };

interface Props {
  open: boolean;
  onClose: () => void;
}


function buildSections(mod: string) {
  return [
    {
      title: () => t("group.file"),
      items: [
        { keys: `${mod}+S`, label: () => t("cmd.save") },
        { keys: `${mod}+Shift+S`, label: () => t("cmd.saveAs") },
        { keys: `${mod}+O`, label: () => t("cmd.open") },
        { keys: `${mod}+N`, label: () => t("cmd.new") },
      ],
    },
    {
      title: () => t("group.edit"),
      items: [
        { keys: `${mod}+Z`, label: () => "Undo" },
        { keys: `${mod}+Shift+Z`, label: () => "Redo" },
        { keys: `${mod}+X`, label: () => "Cut" },
        { keys: `${mod}+C`, label: () => "Copy" },
        { keys: `${mod}+V`, label: () => "Paste" },
        { keys: `${mod}+A`, label: () => "Select All" },
        { keys: `${mod}+F`, label: () => t("cmd.search") },
        { keys: mod === "⌘" ? "⇧⌥F" : "Shift+Alt+F", label: () => t("cmd.edit.formatDocument") },
      ],
    },
    {
      title: () => t("group.view"),
      items: [
        { keys: `${mod}+1`, label: () => t("cmd.source") },
        { keys: `${mod}+2`, label: () => t("cmd.split") },
        { keys: `${mod}+3`, label: () => t("cmd.preview") },
        { keys: `${mod}+4`, label: () => "WYSIWYG" },
        { keys: `${mod}+Shift+F`, label: () => t("cmd.focusMode") ?? "Focus Mode" },
      ],
    },
    {
      title: () => "Navigation",
      items: [
        { keys: `${mod}+K`, label: () => t("cmd.cmdPalette") },
        { keys: `${mod}+/`, label: () => t("cmd.shortcuts") ?? "Keyboard Shortcuts" },
        { keys: "Esc", label: () => t("palette.close") },
      ],
    },
  ];
}

export function KeyboardShortcuts({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Compute platform-aware sections at render time, not module load —
  // some webview contexts (tests, sandboxed iframes) don't have
  // navigator.platform populated until after the bundle parses.
  const SECTIONS = useMemo(
    () => buildSections(detectIsMac() ? "⌘" : "Ctrl"),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="cmd-palette-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "70vh",
          overflow: "auto",
          background: "hsl(var(--bg-muted))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 16,
          padding: "24px 28px",
          boxShadow: "0 20px 60px hsl(0 0% 0% / 0.4)",
        }}
      >
        <h2
          style={{
            fontSize: 16,
            fontWeight: 700,
            marginBottom: 20,
            color: "hsl(var(--fg))",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          ⌨️ {t("cmd.shortcuts") ?? "Keyboard Shortcuts"}
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "hsl(var(--fg-muted))",
              cursor: "pointer",
              fontSize: 18,
              padding: "4px 8px",
              borderRadius: 6,
            }}
          >
            ✕
          </button>
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 20,
          }}
        >
          {SECTIONS.map((section, si) => (
            <div key={si}>
              <h3
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "hsl(var(--accent))",
                  marginBottom: 8,
                }}
              >
                {section.title()}
              </h3>
              {section.items.map((item, ii) => (
                <div
                  key={ii}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "5px 0",
                    fontSize: 12,
                    color: "hsl(var(--fg-subtle))",
                    borderBottom: "1px solid hsl(var(--border) / 0.3)",
                  }}
                >
                  <span>{item.label()}</span>
                  <kbd
                    style={{
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "hsl(var(--bg-inset))",
                      border: "1px solid hsl(var(--border))",
                      fontFamily: "inherit",
                      color: "hsl(var(--fg-muted))",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.keys}
                  </kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
