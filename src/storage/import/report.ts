/**
 * The import report in words (the wizard's last step, and the note it
 * can save): what came in, what did not and why, which links point at
 * nothing.
 */
import "./strings";
import { getLocale, t } from "../../i18n";
import { SOURCE_NAMES } from "./convert";
import type { ImportIssue, ImportReport, SkipReason, WarningReason } from "./types";

export function skipText(i: ImportIssue<SkipReason>): string {
  const why = t(`importWizard.reason.${i.reason}`);
  return i.reason === "unsupported" && i.detail ? `${why} — ${t("importWizard.reason.hint", { hint: i.detail })}` : why;
}

export function warningText(i: ImportIssue<WarningReason>): string {
  const why = t(`importWizard.warn.${i.reason}`);
  return i.detail ? `${why} (${i.detail})` : why;
}

export function linkPercent(r: Pick<ImportReport, "links">): number {
  return r.links.total ? Math.floor((r.links.resolved / r.links.total) * 1000) / 10 : 100;
}

const LIST_MAX = 500;

function list<T>(items: T[], line: (x: T) => string): string {
  const shown = items.slice(0, LIST_MAX).map((x) => `- ${line(x)}`);
  if (items.length > LIST_MAX) shown.push(`- ${t("importWizard.more", { n: items.length - LIST_MAX })}`);
  return shown.join("\n");
}

const code = (p: string) => `\`${p.replace(/`/g, "'")}\``;

/** The report as a Markdown note. */
export function reportMarkdown(r: ImportReport): string {
  const date = new Date(r.at).toLocaleString(getLocale());
  const parts = [
    `# ${t("importWizard.report.heading")}`,
    t("importWizard.report.from", { source: SOURCE_NAMES[r.source], date }),
    t("importWizard.review.summary", { notes: r.notes, attachments: r.attachments, bases: r.bases, folder: r.folder }),
    r.links.total ? t("importWizard.review.links", { resolved: r.links.resolved, total: r.links.total, pct: linkPercent(r) }) : t("importWizard.review.noLinks"),
  ];
  if (r.attachmentsLost) parts.push(t("importWizard.lost", { n: r.attachmentsLost }));
  if (r.skipped.length) parts.push(`## ${t("importWizard.review.skipped", { n: r.skipped.length })}\n\n${list(r.skipped, (i) => `${code(i.path)} — ${skipText(i)}`)}`);
  if (r.warnings.length) parts.push(`## ${t("importWizard.review.warnings", { n: r.warnings.length })}\n\n${list(r.warnings, (i) => `${code(i.path)} — ${warningText(i)}`)}`);
  if (r.links.unresolved.length) parts.push(`## ${t("importWizard.review.unresolved", { n: r.links.total - r.links.resolved })}\n\n${list(r.links.unresolved, (u) => `${code(u.path)} → ${code(u.target)}`)}`);
  return `${parts.join("\n\n")}\n`;
}
