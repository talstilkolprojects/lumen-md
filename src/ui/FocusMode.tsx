import React, { useEffect, useCallback } from "react";
import { t } from "../i18n";

/**
 * FocusMode overlay.
 * When active, covers the entire viewport with a clean, distraction-free writing surface.
 * Renders children (the editor) inside a comfortable centered column.
 */
interface Props {
  active: boolean;
  onExit: () => void;
  children: React.ReactNode;
}

export function FocusMode({ active, onExit, children }: Props) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
      }
    },
    [onExit],
  );

  useEffect(() => {
    if (!active) return;
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [active, handleKey]);

  if (!active) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "hsl(var(--bg))",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* Thin exit bar */}
      <div
        style={{
          width: "100%",
          padding: "6px 16px",
          display: "flex",
          justifyContent: "flex-end",
          opacity: 0.3,
          transition: "opacity var(--duration-base) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.opacity = "0.3";
        }}
      >
        <button
          onClick={onExit}
          title={t("focusMode.exit")}
          style={{
            background: "hsl(var(--bg-muted))",
            border: "1px solid hsl(var(--border))",
            color: "hsl(var(--fg-muted))",
            borderRadius: 8,
            padding: "4px 14px",
            fontSize: 11,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("focusMode.exitShort")}
        </button>
      </div>
      {/* Centered editor area */}
      <div
        style={{
          flex: 1,
          width: "min(780px, 92vw)",
          overflow: "auto",
          paddingBottom: 80,
        }}
      >
        {children}
      </div>
    </div>
  );
}
