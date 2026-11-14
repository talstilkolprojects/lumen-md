import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, X, Search } from "lucide-react";
import type { Command } from "./CommandPalette";
import { t } from "../i18n";
import { countCommand } from "../metrics/count";

/**
 * Floating "AI Prompts" button anchored beside the document body.
 *
 * Mirrors `<InsertFab />`: a circular pill that expands into a panel of all
 * locale-filtered AI prompts plus the AI settings entry. Keeps the menu bar
 * uncluttered and gives the AI flow its own document-anchored entry point.
 */

interface Props {
  commands: Command[];
}

export function AiFab({ commands }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown (plan 10.2.1): a tap outside closes it too, not only a mouse click.
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const aiCommands = useMemo(
    () => commands.filter((c) => c.id.startsWith("ai.")),
    [commands],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return aiCommands;
    return aiCommands.filter((c) =>
      `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q),
    );
  }, [aiCommands, query]);

  function run(cmd: Command) {
    setOpen(false);
    setQuery("");
    countCommand(cmd.id);
    cmd.action();
  }

  return (
    <div
      ref={ref}
      className="ai-fab"
      style={{
        position: "fixed",
        // Stack above the InsertFab so both stay reachable.
        bottom: 84,
        insetInlineEnd: 24,
        zIndex: 30,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title={t("group.ai")}
        aria-label={t("group.ai")}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="ai-fab"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px",
          borderRadius: 999,
          border: "none",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          color: "white",
          background: "linear-gradient(135deg,#c084fc 0%,#f97316 100%)",
          boxShadow: "0 8px 24px -6px hsl(280 92% 55% / 0.45)",
          transition: "transform 120ms ease, box-shadow 120ms ease",
        }}
      >
        {open ? <X size={16} aria-hidden /> : <Sparkles size={16} aria-hidden />}
        <span>{open ? t("insertText.cancel") : t("group.ai")}</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 10px)",
            insetInlineEnd: 0,
            minWidth: 320,
            maxWidth: "min(360px, calc(100vw - 48px))",
            maxHeight: "60vh",
            overflowY: "auto",
            background: "hsl(var(--bg))",
            border: "1px solid hsl(var(--border-strong))",
            borderRadius: 12,
            boxShadow: "0 16px 48px -8px hsl(0 0% 0% / 0.45)",
            padding: "6px 0",
            animation: "cmdSlideIn 140ms ease",
          }}
        >
          <div
            style={{
              padding: "6px 10px",
              borderBottom: "1px solid hsl(var(--border))",
              position: "sticky",
              top: 0,
              background: "hsl(var(--bg))",
            }}
          >
            <div style={{ position: "relative" }}>
              <Search
                size={14}
                aria-hidden
                style={{
                  position: "absolute",
                  insetInlineStart: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "hsl(var(--fg-muted))",
                }}
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("ai.fab.searchPlaceholder")}
                aria-label={t("ai.fab.searchLabel")}
                autoFocus
                style={{
                  width: "100%",
                  // The search icon sits on the inline-start side: the room for it must too.
                  padding: "6px 10px",
                  paddingInlineStart: 28,
                  background: "hsl(var(--bg-subtle))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "hsl(var(--fg))",
                  outline: "none",
                }}
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div style={{ padding: "12px 16px", fontSize: 12, color: "hsl(var(--fg-muted))" }}>
              {t("insertText.previewEmpty")}
            </div>
          ) : (
            filtered.map((cmd) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  role="menuitem"
                  onClick={() => run(cmd)}
                  title={cmd.hint ?? cmd.label}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    width: "100%",
                    padding: "8px 14px",
                    border: "none",
                    background: "transparent",
                    color: "hsl(var(--fg))",
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "start",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "hsl(var(--accent) / 0.06)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                >
                  {Icon ? <Icon size={14} style={{ marginTop: 2, flexShrink: 0 }} /> : <Sparkles size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
                  <span style={{ flex: 1 }}>
                    <span style={{ fontWeight: 500 }}>{cmd.label}</span>
                    {cmd.hint && (
                      <span style={{ display: "block", fontSize: 11, color: "hsl(var(--fg-muted))" }}>
                        {cmd.hint}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
