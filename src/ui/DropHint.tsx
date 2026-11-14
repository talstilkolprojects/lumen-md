/** The hint over the editor while a file is dragged onto it (W6.25: moved out of App.tsx unchanged). */
import { t } from "../i18n";

export function DropHint() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-none animate-in"
      style={{
        background: "hsl(var(--accent) / 0.06)",
        border: "2px dashed hsl(var(--accent))",
        borderRadius: 12,
        margin: 12,
      }}
    >
      <div
        style={{
          background: "hsl(var(--bg))",
          padding: "1rem 1.5rem",
          borderRadius: 10,
          fontSize: 14,
          color: "hsl(var(--accent))",
          border: "1px solid hsl(var(--accent) / 0.3)",
          fontWeight: 600,
        }}
      >
        {t("dnd.dropHint")}
      </div>
    </div>
  );
}
