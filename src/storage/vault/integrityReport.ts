/**
 * The vault integrity check as a note (plan W1.5): one section per kind of
 * problem, each file as a link, and what the repair would do. Loaded only
 * when the command runs.
 */
import "./integrityStrings";
import { t } from "../../i18n";
import { INTEGRITY_KINDS, REPAIRABLE, type IntegrityFinding, type IntegrityKind, type IntegrityReport } from "./integrity";

const FIX: Partial<Record<IntegrityKind, string>> = {
  "truncated-utf8": "vaultCheck.fix.truncated-utf8",
  "invalid-utf8": "vaultCheck.fix.invalid-utf8",
  utf16: "vaultCheck.fix.utf16",
  "nul-bytes": "vaultCheck.fix.nul-bytes",
  "case-collision": "vaultCheck.fix.collision",
  "normalization-collision": "vaultCheck.fix.collision",
  "orphan-temp": "vaultCheck.fix.orphan-temp",
  "interrupted-write": "vaultCheck.fix.interrupted-write",
};
const WHY: Partial<Record<IntegrityKind, string>> = {
  "empty-file": "vaultCheck.why.empty-file",
  "bad-data": "vaultCheck.why.data",
  "bad-frontmatter": "vaultCheck.why.data",
  "broken-link": "vaultCheck.why.broken-link",
};

/** At most this many files per kind are listed. */
const LIMIT = 200;

const link = (p: string) => (/\.(md|markdown)$/i.test(p) ? `[[${p.replace(/\.(md|markdown)$/i, "")}]]` : `\`${p.replace(/`/g, "'")}\``);
const code = (s: string) => `\`${s.replace(/`/g, "'").slice(0, 120)}\``;

export function formatIntegrityReport(report: IntegrityReport): string {
  const seconds = (report.ms / 1000).toFixed(1);
  const repairable = report.findings.filter((f) => REPAIRABLE.has(f.kind)).length;
  const lines = [
    `# ${t("vaultCheck.title")}`,
    "",
    report.findings.length
      ? t("vaultCheck.summary", { files: report.files, seconds, count: report.findings.length, repairable })
      : t("vaultCheck.clean", { files: report.files, seconds }),
    "",
  ];
  for (const kind of INTEGRITY_KINDS) {
    const group: IntegrityFinding[] = report.findings.filter((f) => f.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${t(`vaultCheck.kind.${kind}`)} (${group.length})`, "");
    const fix = FIX[kind];
    lines.push(fix ? t("vaultCheck.fix.yes", { fix: t(fix) }) : t("vaultCheck.fix.no", { why: t(WHY[kind] ?? "vaultCheck.why.data") }), "");
    for (const f of group.slice(0, LIMIT)) {
      const detail = !f.detail
        ? ""
        : kind === "case-collision" || kind === "normalization-collision"
          ? ` — ${t("vaultCheck.same", { other: code(f.detail) })}`
          : ` — ${code(f.detail)}`;
      lines.push(`- ${link(f.path)}${detail}`);
    }
    if (group.length > LIMIT) lines.push(`- ${t("vaultCheck.more", { n: group.length - LIMIT })}`);
    lines.push("");
  }
  return lines.join("\n");
}
