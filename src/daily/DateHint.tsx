/**
 * The Hebrew date (and, for a deadline, the suggested working day) next to a
 * date in the note's properties (plan W5.15). Lazy: src/ui/Frontmatter.tsx
 * loads it only for values that look like dates.
 */
import { useAppStore } from "../store/useStore";
import { DEADLINE_KEY, dateCell } from "./dateCells";
import { deadlineText } from "./deadlineText";
import "./israeliTimeStrings";


export default function DateHint({ name, value }: { name: string; value: unknown }) {
  const locale = useAppStore((s) => s.locale) as string;
  const settings = useAppStore((s) => s.dailyNotes);
  const cell = dateCell(value, { locale, settings, deadline: DEADLINE_KEY.test(name) });
  if (!cell) return null;
  const d = cell.deadline && deadlineText(cell.deadline);
  return (
    <>
      {cell.hebrew && (
        <span data-testid="hebrew-date" lang="he" dir={locale === "he" ? "rtl" : "auto"} style={{ marginInlineStart: 6, color: "hsl(var(--fg-muted))" }}>
          ({cell.hebrew})
        </span>
      )}
      {d?.moved && (
        <span data-testid="deadline-moved" role="note" style={{ marginInlineStart: 6, color: "hsl(var(--warning, 35 90% 40%))" }}>
          ⚠ {d.moved}
        </span>
      )}
      {d?.notes && <span style={{ marginInlineStart: 6, color: "hsl(var(--fg-muted))" }}>· {d.notes}</span>}
    </>
  );
}
