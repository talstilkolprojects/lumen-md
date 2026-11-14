/**
 * The words for a deadline (plan W5.15), shared by the properties hint
 * (DateHint) and the database views. The English comes with those lazily
 * loaded views (./israeliTimeStrings), never at startup.
 */
import { t, tPlural } from "../i18n";
import type { DateCell } from "./dateCells";

/** The words for a deadline cell: "Falls on Shabbat · Rosh Hashana I: suggested 2026-09-14 (Tzom Gedaliah)", "1 working day left". */
export function deadlineText(d: NonNullable<DateCell["deadline"]>): { moved: string | null; left: string; notes: string | null } {
  const notes = d.notes.length ? d.notes.join(" · ") : null;
  const base = d.moved ? t("israeliTime.moved", { reason: d.off.join(" · "), date: d.due }) : d.off.length ? t("israeliTime.dayOff", { reason: d.off.join(" · ") }) : null;
  // why: a moved deadline's notes are about the day it moves to, so they go with that date
  const moved = base && d.moved && notes ? `${base} (${notes})` : base;
  const left = d.left === 0 ? t("israeliTime.dueToday") : d.left > 0 ? tPlural("israeliTime.left", d.left) : tPlural("israeliTime.overdue", -d.left);
  return { moved, left, notes: d.moved ? null : notes };
}
