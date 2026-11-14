/**
 * The 50 screenshot fixtures of plan W7.16: 25 Hebrew and 25 English, each
 * language with 9 tables, 8 dialogs and 8 code / error screens. Every case is
 * an HTML screen (rendered to PNG by make.mjs, in Chromium, with the repo's
 * OFL fonts) and the Markdown a perfect transcription gives. Deterministic:
 * the same file always makes the same 50 cases.
 *
 * These are development fixtures written with the pipeline, not a held-out
 * set: the held-out measurement goes through W6.17's evaluator.
 */

const HE = {
  tables: [
    { title: "ציונים - סמסטר א", head: ["שם", "מבחן", "עבודה", "סופי"], rows: [["דנה לוי", "88", "92", "90"], ["יוסי כהן", "75", "80", "78"], ["מיכל אברהם", "94", "85", "90"]] },
    { title: "הוצאות חודש נובמבר", head: ["קטגוריה", "סכום", "הערה"], rows: [["שכירות", "4,200", "הוראת קבע"], ["חשמל", "380", "דו-חודשי"], ["מכולת", "1,150", ""], ["תחבורה", "290", "רב-קו"]] },
    { title: "לוח זמנים", head: ["יום", "שעה", "חדר", "קורס"], rows: [["ראשון", "08:30", "201", "מבוא לסטטיסטיקה"], ["שלישי", "12:00", "114", "כלכלה"], ["חמישי", "10:15", "305", "תכנות"]] },
    { title: "מלאי", head: ["מק\"ט", "מוצר", "כמות"], rows: [["A-104", "מחברת", "120"], ["B-220", "עט כחול", "540"], ["C-031", "קלסר", "36"]] },
    { title: "תוצאות ניסוי", head: ["דגימה", "טמפרטורה", "pH"], rows: [["1", "21.5", "7.1"], ["2", "22.0", "6.9"], ["3", "23.4", "7.3"], ["4", "24.1", "7.0"]] },
    { title: "משמרות", head: ["עובד", "בוקר", "ערב"], rows: [["רוני", "כן", "לא"], ["שירה", "לא", "כן"], ["אבי", "כן", "כן"]] },
    { title: "מחירון", head: ["שירות", "מחיר", "זמן"], rows: [["תיקון מסך", "650 ₪", "שעתיים"], ["החלפת סוללה", "290 ₪", "שעה"], ["ניקוי", "90 ₪", "20 דקות"]] },
    { title: "השוואת דירות", head: ["כתובת", "חדרים", "קומה", "מחיר"], rows: [["הרצל 12", "3", "2", "5,800"], ["ויצמן 40", "4", "5", "7,100"]] },
    { title: "משימות הפרויקט", head: ["משימה", "אחראי", "סטטוס", "תאריך יעד"], rows: [["איסוף נתונים", "נועה", "בוצע", "01.11"], ["ניתוח", "עומר", "בתהליך", "20.11"], ["כתיבת דוח", "נועה", "פתוח", "30.11"]] },
  ],
  dialogs: [
    { title: "לשמור את השינויים?", body: "יש שינויים שלא נשמרו בקובץ \"סיכום פגישה\".", buttons: ["שמור", "אל תשמור", "ביטול"] },
    { title: "מחיקת תיקייה", body: "התיקייה \"ארכיון 2025\" וכל 48 הקבצים שבה יימחקו לצמיתות.", buttons: ["מחק", "ביטול"] },
    { title: "אין חיבור לאינטרנט", body: "בדקו את הרשת ונסו שוב. השינויים נשמרים במכשיר.", buttons: ["נסה שוב", "סגור"] },
    { title: "עדכון זמין", body: "גרסה 2.4 מוכנה להתקנה. ההתקנה תימשך כדקה.", buttons: ["התקן עכשיו", "מאוחר יותר"] },
    { title: "הסיסמה שגויה", body: "נותרו 2 ניסיונות לפני שהחשבון יינעל לחצי שעה.", buttons: ["נסה שוב", "שכחתי סיסמה"] },
    { title: "הקובץ גדול מדי", body: "הקובץ \"מצגת.pptx\" שוקל 120MB. המגבלה היא 100MB.", buttons: ["בחר קובץ אחר", "ביטול"] },
    { title: "הרשאת מיקרופון", body: "האתר www.example.co.il מבקש גישה למיקרופון.", buttons: ["אפשר", "חסום"] },
    { title: "התשלום התקבל", body: "קבלה מספר 10422 נשלחה לכתובת הדוא\"ל שלך.", buttons: ["אישור"] },
  ],
  code: [
    { title: "מסוף", lines: ["$ npm run build", "npm ERR! code ELIFECYCLE", "npm ERR! errno 1"], prose: "הבנייה נכשלה אחרי עדכון החבילות." },
    { title: "שגיאה בהרצה", lines: ["Traceback (most recent call last):", "  File \"main.py\", line 12, in <module>", "ZeroDivisionError: division by zero"], prose: "הסקריפט נעצר בשורה 12." },
    { title: "יומן השרת", lines: ["ERROR 2026-11-14 10:02:11 connection refused", "ERROR 2026-11-14 10:02:16 retry 2 of 5"], prose: "השרת לא עונה מאז הבוקר." },
    { title: "קוד", code: ["function sum(a, b) {", "  return a + b;", "}"], prose: "פונקציה פשוטה לחיבור." },
    { title: "הודעת מערכת", lines: ["שגיאה: הקובץ config.json לא נמצא"], prose: "צריך ליצור את הקובץ לפני ההפעלה." },
    { title: "קונסולת הדפדפן", lines: ["Uncaught TypeError: Cannot read properties of undefined (reading 'map')", "    at render (app.js:42:17)"], prose: "הרשימה ריקה בטעינה הראשונה." },
    { title: "הגדרות", code: ["[server]", "port = 8080", "host = \"0.0.0.0\""], prose: "קובץ ההגדרות של השרת." },
    { title: "Git", lines: ["error: failed to push some refs to 'origin'"], prose: "צריך למשוך שינויים לפני הדחיפה." },
  ],
};

const EN = {
  tables: [
    { title: "Q3 revenue by region", head: ["Region", "Revenue", "Growth"], rows: [["North", "$1.2M", "4%"], ["South", "$860K", "-2%"], ["West", "$2.4M", "11%"]] },
    { title: "Sprint board", head: ["Ticket", "Owner", "Status"], rows: [["LUM-101", "Ana", "Done"], ["LUM-114", "Ben", "In review"], ["LUM-120", "Chen", "Open"], ["LUM-121", "Ana", "Open"]] },
    { title: "Train times", head: ["Departs", "Arrives", "Platform", "Notes"], rows: [["07:15", "08:02", "3", "Express"], ["07:40", "08:41", "1", ""], ["08:05", "08:52", "3", "Express"]] },
    { title: "Grades", head: ["Student", "Midterm", "Final"], rows: [["Avery", "B+", "A-"], ["Jordan", "A", "A"], ["Riley", "C", "B"]] },
    { title: "Server metrics", head: ["Host", "CPU", "Memory", "Disk"], rows: [["web-1", "32%", "4.1 GB", "61%"], ["web-2", "87%", "7.8 GB", "64%"], ["db-1", "45%", "28 GB", "80%"]] },
    { title: "Recipe scaling", head: ["Ingredient", "2 servings", "6 servings"], rows: [["Flour", "200 g", "600 g"], ["Eggs", "2", "6"], ["Milk", "150 ml", "450 ml"]] },
    { title: "Subscription plans", head: ["Plan", "Price", "Seats"], rows: [["Free", "$0", "1"], ["Team", "$8", "10"], ["Business", "$15", "Unlimited"]] },
    { title: "Exchange rates", head: ["Currency", "Buy", "Sell"], rows: [["USD", "3.71", "3.78"], ["EUR", "4.02", "4.10"], ["GBP", "4.70", "4.81"]] },
    { title: "Reading list", head: ["Title", "Author", "Year"], rows: [["Middlemarch", "George Eliot", "1871"], ["Dubliners", "James Joyce", "1914"]] },
  ],
  dialogs: [
    { title: "Save changes?", body: "Your changes to \"Meeting notes\" will be lost if you don't save them.", buttons: ["Save", "Don't Save", "Cancel"] },
    { title: "Delete 3 items?", body: "This action cannot be undone.", buttons: ["Delete", "Cancel"] },
    { title: "Software Update", body: "Version 14.2 is available. Restart to install.", buttons: ["Restart Now", "Later"] },
    { title: "Sign in required", body: "Your session expired. Sign in again to continue.", buttons: ["Sign In"] },
    { title: "Allow notifications?", body: "app.example.com wants to show notifications.", buttons: ["Allow", "Block"] },
    { title: "Low battery", body: "12% battery remaining. Connect your charger.", buttons: ["OK"] },
    { title: "Replace file?", body: "A file named \"report.pdf\" already exists in this folder.", buttons: ["Replace", "Keep Both", "Stop"] },
    { title: "Connection lost", body: "Trying to reconnect in 10 seconds.", buttons: ["Reconnect", "Work Offline"] },
  ],
  code: [
    { title: "Terminal", lines: ["$ cargo build", "error[E0425]: cannot find value `x` in this scope"], prose: "The build broke after the refactor." },
    { title: "Python", lines: ["Traceback (most recent call last):", "  File \"app.py\", line 7, in <module>", "KeyError: 'user_id'"], prose: "The request had no user id." },
    { title: "Code review", code: ["const total = items.reduce((s, i) => s + i.price, 0);"], prose: "Sum of the cart." },
    { title: "Browser console", lines: ["Uncaught ReferenceError: process is not defined", "    at main.js:3:9"], prose: "Happens only in the production bundle." },
    { title: "Kubernetes", lines: ["Error from server (NotFound): pods \"api-7d9\" not found"], prose: "The pod was rescheduled." },
    { title: "SQL", code: ["SELECT name, COUNT(*)", "FROM orders", "GROUP BY name;"], prose: "Orders per customer." },
    { title: "Go", lines: ["panic: runtime error: index out of range [3] with length 3"], prose: "Off by one in the loop." },
    { title: "Shell script", code: ["#!/bin/sh", "set -eu", "echo \"done\""], prose: "Deploy helper." },
  ],
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cellMd = (s) => s.replace(/\|/g, "\\|");

function tableCase(t, lang, i) {
  const html = `<h2>${esc(t.title)}</h2><table><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const md = [`## ${t.title}`, "", `| ${t.head.map(cellMd).join(" | ")} |`, `| ${t.head.map(() => "---").join(" | ")} |`, ...t.rows.map((r) => `| ${r.map(cellMd).join(" | ")} |`)].join("\n");
  return { id: `${lang}-table-${i + 1}`, lang, kind: "table", html, gold: md };
}

function dialogCase(d, lang, i) {
  const html = `<div class="dialog"><h3>${esc(d.title)}</h3><p>${esc(d.body)}</p><div class="buttons">${d.buttons.map((b) => `<button>${esc(b)}</button>`).join("")}</div></div>`;
  const md = [`### ${d.title}`, "", d.body, "", ...d.buttons.map((b) => `- ${b}`)].join("\n");
  return { id: `${lang}-dialog-${i + 1}`, lang, kind: "dialog", html, gold: md };
}

function codeCase(c, lang, i) {
  const body = c.code ?? c.lines;
  const html = `<h3>${esc(c.title)}</h3><p>${esc(c.prose)}</p><pre dir="ltr">${body.map(esc).join("\n")}</pre>`;
  const md = [`### ${c.title}`, "", c.prose, "", c.code ? "```" : "```text", ...body, "```"].join("\n");
  return { id: `${lang}-code-${i + 1}`, lang, kind: c.code ? "code" : "error", html, gold: md };
}

export function cases() {
  const out = [];
  for (const [lang, set] of [["he", HE], ["en", EN]]) {
    set.tables.forEach((t, i) => out.push(tableCase(t, lang, i)));
    set.dialogs.forEach((d, i) => out.push(dialogCase(d, lang, i)));
    set.code.forEach((c, i) => out.push(codeCase(c, lang, i)));
  }
  return out;
}

export const FONTS = { he: ["assistant.woff2", "Assistant"], en: ["assistant.woff2", "Assistant"] };

/** One screen as a full HTML page: a window frame, RTL for Hebrew, the repo's Assistant font (OFL). */
export function page(c, fontUrl) {
  const dir = c.lang === "he" ? "rtl" : "ltr";
  return `<!doctype html><html lang="${c.lang}" dir="${dir}"><meta charset="utf-8"><style>
@font-face { font-family: Shot; src: url(${fontUrl}) format("woff2"); }
body { margin: 0; background: #e9ecef; font: 17px/1.5 Shot, sans-serif; color: #1d2125; }
.win { margin: 18px; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px #0002; padding: 18px 24px; width: 720px; }
table { border-collapse: collapse; } th, td { border: 1px solid #adb5bd; padding: 6px 14px; text-align: start; } th { background: #f1f3f5; }
pre { background: #1e1e1e; color: #d4d4d4; padding: 12px 14px; font: 15px/1.45 "DejaVu Sans Mono", monospace; border-radius: 6px; white-space: pre; }
.dialog { border: 1px solid #ced4da; border-radius: 10px; padding: 8px 20px 16px; } .buttons { display: flex; gap: 10px; }
button { font: inherit; padding: 4px 16px; border-radius: 6px; border: 1px solid #868e96; background: #f8f9fa; }
</style><div class="win">${c.html}</div></html>`;
}
