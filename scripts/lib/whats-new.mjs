/**
 * "What's new" (plan 14.6), the part shared by the build, the release script
 * and the tests: one version's notes from the changelog, in a language.
 *
 * English is CHANGELOG.md (written by scripts/release.mjs from the commit
 * subjects, 13.4). Each other language has changelog/<locale>.md with the
 * same `## [x.y.z] - date` sections, translated; `release.mjs prepare`
 * copies the new English section into each of them marked
 * `<!-- untranslated -->` until someone translates it. A language without
 * a translated section gets the English notes under its own headings, and
 * says so.
 */

export const LOCALES = ["en", "he", "ar", "ru", "fr", "de", "ja", "zh-CN"];
export const UNTRANSLATED = "<!-- untranslated -->";

/** The section headings release.mjs writes, per language. */
export const HEADINGS = {
  en: { breaking: "⚠ Breaking changes", feat: "Added", fix: "Fixed", perf: "Performance", revert: "Reverted", docs: "Documentation" },
  he: { breaking: "⚠ שינויים שוברים", feat: "חדש", fix: "תוקן", perf: "ביצועים", revert: "בוטל", docs: "תיעוד" },
  ar: { breaking: "⚠ تغييرات جذرية", feat: "جديد", fix: "إصلاحات", perf: "الأداء", revert: "تراجع", docs: "التوثيق" },
  ru: { breaking: "⚠ Несовместимые изменения", feat: "Новое", fix: "Исправлено", perf: "Производительность", revert: "Отменено", docs: "Документация" },
  fr: { breaking: "⚠ Changements incompatibles", feat: "Nouveautés", fix: "Corrections", perf: "Performances", revert: "Annulé", docs: "Documentation" },
  de: { breaking: "⚠ Inkompatible Änderungen", feat: "Neu", fix: "Behoben", perf: "Leistung", revert: "Zurückgenommen", docs: "Dokumentation" },
  ja: { breaking: "⚠ 互換性のない変更", feat: "新機能", fix: "修正", perf: "パフォーマンス", revert: "取り消し", docs: "ドキュメント" },
  "zh-CN": { breaking: "⚠ 不兼容的变更", feat: "新增", fix: "修复", perf: "性能", revert: "撤销", docs: "文档" },
};

/** One version's section ("## [1.2.0] - 2026-11-10" up to the next "## ["), or null. */
export function versionSection(changelog, version) {
  const v = String(version).replace(/^v/, "").replace(/\./g, "\\.");
  const m = new RegExp(`^## \\[${v}\\](?: - (\\d{4}-\\d\\d-\\d\\d))?[^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m").exec(changelog ?? "");
  return m ? { date: m[1] ?? null, body: m[2].trim() } : null;
}

/** For people, not maintainers: commit links and `**scope:**` prefixes go. */
export function forReaders(body) {
  return body
    .replace(/\s*\(\[[0-9a-f]{7}\]\(https?:\/\/[^)]+\)\)/g, "")
    .replace(/^(\s*- )\*\*[^*]+:\*\*\s*/gm, "$1")
    // Keep a Changelog's link references at the end of the file ("[0.1.0]: https://…").
    .replace(/^\[[^\]\n]+\]:\s*\S+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** English headings → the language's (for an untranslated section). */
export function localizeHeadings(body, locale) {
  const en = HEADINGS.en;
  const to = HEADINGS[locale] ?? en;
  let out = body;
  for (const k of Object.keys(en)) out = out.replace(new RegExp(`^### ${en[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm"), `### ${to[k]}`);
  return out;
}

/**
 * The notes of `version` in every language: `{ version, date, notes: { [locale]: { markdown, translated } } }`,
 * or null when CHANGELOG.md has no section for it. `translations` maps a locale to its changelog/<locale>.md text.
 */
export function whatsNew(version, english, translations = {}) {
  const en = versionSection(english, version);
  if (!en) return null;
  const notes = { en: { markdown: forReaders(en.body), translated: true } };
  for (const locale of LOCALES.filter((l) => l !== "en")) {
    const tr = versionSection(translations[locale] ?? "", version);
    if (tr && !tr.body.includes(UNTRANSLATED) && tr.body.trim()) notes[locale] = { markdown: forReaders(tr.body), translated: true };
    else notes[locale] = { markdown: localizeHeadings(forReaders(en.body), locale), translated: false };
  }
  return { version: String(version).replace(/^v/, ""), date: en.date, notes };
}

/** The new English section copied into a translation file, marked untranslated (release.mjs prepare). */
export function addUntranslated(translation, section) {
  const marked = section.replace(/^(## [^\n]*\n)/, `$1\n${UNTRANSLATED}\n`);
  const text = translation || "";
  const first = text.search(/^## \[/m);
  if (first >= 0) return `${text.slice(0, first)}${marked}\n${text.slice(first)}`;
  return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${marked}`;
}
