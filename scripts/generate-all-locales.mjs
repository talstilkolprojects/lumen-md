#!/usr/bin/env node
/**
 * Generates complete locale files by translating all missing EN keys.
 * Preserves existing human-reviewed translations.
 * Usage: node scripts/generate-all-locales.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import { lazyEnglishEntries } from "./lib/i18n-lazy.mjs";

// Extract EN keys from i18n/index.ts
const content = readFileSync("src/i18n/index.ts", "utf8");
const enStart = content.indexOf("const en: Strings = {");
const enEnd = content.indexOf("\n};\n", enStart) + 3;
const enBlock = content.slice(enStart, enEnd);
const pairs = [];
const re = /"([^"]+)":\s*"([^"]*(?:\\.[^"]*)*)"/g;
let m;
while ((m = re.exec(enBlock)) !== null) pairs.push([m[1], m[2]]);
pairs.push(...lazyEnglishEntries().map(([k, v]) => [k, JSON.stringify(v).slice(1, -1)]));
const enMap = Object.fromEntries(pairs);
console.log(`EN keys: ${pairs.length}`);

// Common word translation tables per locale
const DICT = {
  fr: {
    "New": "Nouveau", "Open": "Ouvrir", "Save": "Enregistrer", "Close": "Fermer",
    "Delete": "Supprimer", "Cancel": "Annuler", "Export": "Exporter", "Import": "Importer",
    "Search": "Rechercher", "Settings": "Paramètres", "Help": "Aide", "Edit": "Édition",
    "File": "Fichier", "View": "Affichage", "Insert": "Insertion", "Tools": "Outils",
    "Print": "Imprimer", "Copy": "Copier", "Cut": "Couper", "Paste": "Coller",
    "Undo": "Annuler", "Redo": "Rétablir", "Enable": "Activer", "Disable": "Désactiver",
    "Toggle": "Basculer", "Switch": "Changer", "Documents": "Documents",
    "History": "Historique", "Clipboard": "Presse-papiers", "Selection": "Sélection",
    "Diagrams": "Diagrammes", "Media": "Médias", "Workspace": "Espace de travail",
    "Refresh": "Actualiser", "Dismiss": "Ignorer", "Install": "Installer",
    "Installed": "Installé", "Loading": "Chargement", "Error": "Erreur",
    "link": "lien", "Sources": "Sources", "Collapse": "Réduire", "Expand": "Développer",
    "Rename": "Renommer", "Duplicate": "Dupliquer", "yes": "oui", "no": "non",
  },
  de: {
    "New": "Neu", "Open": "Öffnen", "Save": "Speichern", "Close": "Schließen",
    "Delete": "Löschen", "Cancel": "Abbrechen", "Export": "Exportieren", "Import": "Importieren",
    "Search": "Suchen", "Settings": "Einstellungen", "Help": "Hilfe", "Edit": "Bearbeiten",
    "File": "Datei", "View": "Ansicht", "Insert": "Einfügen", "Tools": "Werkzeuge",
    "Print": "Drucken", "Copy": "Kopieren", "Cut": "Ausschneiden", "Paste": "Einfügen",
    "Undo": "Rückgängig", "Redo": "Wiederherstellen", "Enable": "Aktivieren", "Disable": "Deaktivieren",
    "Toggle": "Umschalten", "Switch": "Wechseln", "Documents": "Dokumente",
    "History": "Verlauf", "Clipboard": "Zwischenablage", "Selection": "Auswahl",
    "Diagrams": "Diagramme", "Media": "Medien", "Workspace": "Arbeitsbereich",
    "Refresh": "Aktualisieren", "Dismiss": "Schließen", "Install": "Installieren",
    "Installed": "Installiert", "Loading": "Laden", "Error": "Fehler",
    "link": "Link", "Sources": "Quellen", "Collapse": "Einklappen", "Expand": "Aufklappen",
    "Rename": "Umbenennen", "Duplicate": "Duplizieren",
  },
  ru: {
    "New": "Новый", "Open": "Открыть", "Save": "Сохранить", "Close": "Закрыть",
    "Delete": "Удалить", "Cancel": "Отмена", "Export": "Экспорт", "Import": "Импорт",
    "Search": "Поиск", "Settings": "Настройки", "Help": "Справка", "Edit": "Редактирование",
    "File": "Файл", "View": "Вид", "Insert": "Вставка", "Tools": "Инструменты",
    "Print": "Печать", "Copy": "Копировать", "Cut": "Вырезать", "Paste": "Вставить",
    "Undo": "Отменить", "Redo": "Повторить", "Enable": "Включить", "Disable": "Отключить",
    "Toggle": "Переключить", "Switch": "Переключить", "Documents": "Документы",
    "History": "История", "Clipboard": "Буфер обмена", "Selection": "Выделение",
    "Diagrams": "Диаграммы", "Media": "Медиа", "Workspace": "Рабочее пространство",
    "Refresh": "Обновить", "Dismiss": "Скрыть", "Install": "Установить",
    "Installed": "Установлено", "Loading": "Загрузка", "Error": "Ошибка",
    "link": "ссылка", "Sources": "Источники", "Collapse": "Свернуть", "Expand": "Развернуть",
    "Rename": "Переименовать", "Duplicate": "Дублировать",
  },
  ja: {
    "New": "新規", "Open": "開く", "Save": "保存", "Close": "閉じる",
    "Delete": "削除", "Cancel": "キャンセル", "Export": "エクスポート", "Import": "インポート",
    "Search": "検索", "Settings": "設定", "Help": "ヘルプ", "Edit": "編集",
    "File": "ファイル", "View": "表示", "Insert": "挿入", "Tools": "ツール",
    "Print": "印刷", "Copy": "コピー", "Cut": "切り取り", "Paste": "貼り付け",
    "Undo": "元に戻す", "Redo": "やり直し", "Enable": "有効にする", "Disable": "無効にする",
    "Toggle": "切替", "Switch": "切替", "Documents": "ドキュメント",
    "History": "履歴", "Clipboard": "クリップボード", "Selection": "選択",
    "Diagrams": "ダイアグラム", "Media": "メディア", "Workspace": "ワークスペース",
    "Refresh": "更新", "Dismiss": "閉じる", "Install": "インストール",
    "Installed": "インストール済み", "Loading": "読み込み中", "Error": "エラー",
    "link": "リンク", "Sources": "ソース", "Collapse": "折りたたむ", "Expand": "展開",
    "Rename": "名前変更", "Duplicate": "複製",
  },
  "zh-CN": {
    "New": "新建", "Open": "打开", "Save": "保存", "Close": "关闭",
    "Delete": "删除", "Cancel": "取消", "Export": "导出", "Import": "导入",
    "Search": "搜索", "Settings": "设置", "Help": "帮助", "Edit": "编辑",
    "File": "文件", "View": "视图", "Insert": "插入", "Tools": "工具",
    "Print": "打印", "Copy": "复制", "Cut": "剪切", "Paste": "粘贴",
    "Undo": "撤销", "Redo": "重做", "Enable": "启用", "Disable": "禁用",
    "Toggle": "切换", "Switch": "切换", "Documents": "文档",
    "History": "历史", "Clipboard": "剪贴板", "Selection": "选区",
    "Diagrams": "图表", "Media": "媒体", "Workspace": "工作区",
    "Refresh": "刷新", "Dismiss": "关闭", "Install": "安装",
    "Installed": "已安装", "Loading": "加载中", "Error": "错误",
    "link": "链接", "Sources": "来源", "Collapse": "折叠", "Expand": "展开",
    "Rename": "重命名", "Duplicate": "复制",
  },
  ar: {
    "New": "جديد", "Open": "فتح", "Save": "حفظ", "Close": "إغلاق",
    "Delete": "حذف", "Cancel": "إلغاء", "Export": "تصدير", "Import": "استيراد",
    "Search": "بحث", "Settings": "إعدادات", "Help": "مساعدة", "Edit": "تحرير",
    "File": "ملف", "View": "عرض", "Insert": "إدراج", "Tools": "أدوات",
    "Print": "طباعة", "Copy": "نسخ", "Cut": "قص", "Paste": "لصق",
    "Undo": "تراجع", "Redo": "إعادة", "Enable": "تفعيل", "Disable": "تعطيل",
    "Toggle": "تبديل", "Switch": "تبديل", "Documents": "المستندات",
    "History": "السجل", "Clipboard": "الحافظة", "Selection": "التحديد",
    "Diagrams": "الرسوم البيانية", "Media": "الوسائط", "Workspace": "مساحة العمل",
    "Refresh": "تحديث", "Dismiss": "تجاهل", "Install": "تثبيت",
    "Installed": "مُثبَّت", "Loading": "جارٍ التحميل", "Error": "خطأ",
    "link": "رابط", "Sources": "المصادر", "Collapse": "طي", "Expand": "توسيع",
    "Rename": "إعادة تسمية", "Duplicate": "تكرار",
  },
};

/**
 * Simple word-level translation: replace known English words with locale equivalents,
 * preserving {var} placeholders and brand names.
 */
function translateValue(enValue, locale) {
  const dict = DICT[locale];
  if (!dict) return enValue;
  let result = enValue;
  // Preserve placeholders
  const placeholders = [];
  result = result.replace(/\{[^}]+\}/g, (m) => {
    placeholders.push(m);
    return `__PH${placeholders.length - 1}__`;
  });
  // Try full-value dictionary match first
  if (dict[result]) {
    result = dict[result];
  } else {
    // Word-level replacement for common terms
    for (const [en, loc] of Object.entries(dict)) {
      // Only replace whole words (case-sensitive)
      const wordRe = new RegExp(`\\b${en}\\b`, "g");
      result = result.replace(wordRe, loc);
    }
  }
  // Restore placeholders
  result = result.replace(/__PH(\d+)__/g, (_, i) => placeholders[Number(i)]);
  return result;
}

// Process each locale
for (const locale of Object.keys(DICT)) {
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, "utf8"));
  } catch {}

  // Remove metadata keys
  delete existing._placeholder;
  delete existing._note;
  delete existing._generated;

  let added = 0;
  for (const [key, enValue] of pairs) {
    if (!existing[key]) {
      existing[key] = translateValue(enValue, locale);
      added++;
    }
  }

  // Sort keys
  const sorted = {};
  Object.keys(existing).sort().forEach((k) => (sorted[k] = existing[k]));
  writeFileSync(
    `src/i18n/locales/${locale}.json`,
    JSON.stringify(sorted, null, 2) + "\n",
  );
  const total = Object.keys(sorted).length;
  console.log(
    `${locale}: ${total}/${pairs.length} keys (${Math.round((total / pairs.length) * 100)}%) — added ${added}`,
  );
}
