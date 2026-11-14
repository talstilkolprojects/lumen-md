---
title: דוח תאימות נגישות (ACR) — WCAG 2.2
description: כל קריטריון הצלחה של WCAG 2.2 ברמות A ו-AA, עם הסטטוס של Lumen 0.1.0, הערות, ראיות ותוכנית תיקון.
---

<!-- נוצר על ידי scripts/acr.mjs מתוך docs/acr/wcag22.json — לערוך שם. -->

הדוח הזה בנוי לפי מבנה ה-VPAT®‏ 2.5 (מהדורת WCAG). הוא מכסה את **Lumen 0.1.0** (אתר, שולחן עבודה ונייד) מול **WCAG 2.2** ברמות A ו-AA, ונבדק לאחרונה ב-**2026-11-14**. הוא מתפרסם מחדש עם כל שחרור משמעותי: הבדיקה `node scripts/acr.mjs --check` נכשלת כשגרסת הדוח שונה מגרסת האפליקציה.

## סיכום

| רמה | נתמך | נתמך חלקית | לא נתמך | לא רלוונטי |
|---|---|---|---|---|
| A | 21 | 6 | 0 | 4 |
| AA | 15 | 7 | 0 | 2 |

## איך נבדק

אוטומטי: axe-core בשישה מסכים בעברית ובאנגלית, בבהיר ובכהה (e2e/a11y.spec.ts); התאמה לרוחב 320 ו-640 פיקסלים וצבעים מאולצים (e2e/reflow.spec.ts); הכרזות קוליות (e2e/sr-announce.spec.ts); בדיקות יחידה של לכידת המיקוד, הניגודיות וההודעות. ידני: סקירה של כל קריטריון מול הקוד וההתנהגות של הגרסה הזו. החלק האוטומטי נוצר מהרצת axe-core ‏(docs/acr/axe.json, ‏scripts/acr-axe.mjs): לכל קריטריון מוצגים כללי axe שבודקים אותו, וקריטריון ש-axe מוצא בו הפרה לא יכול להיות מדווח כנתמך.

## בדיקה אוטומטית

**axe-core 4.11.3**, the app's components in headless Chromium, with the app's compiled CSS (offline harness), ב-2026-11-14 (commit `ad415c29a3`): 159 הרצות על 53 משטחים × 3 הגדרות (he/light, he/dark, en/light), 32 כללים של WCAG 2.0/2.1/2.2 ברמות A ו-AA, **4 כללים עם הפרות**. העמודה ״axe״ בטבלאות למטה מראה, לכל קריטריון, את הכללים שבודקים אותו ואת התוצאה. axe בודק רק חלק מ-WCAG; כל השאר נבדק ידנית, כמתואר למעלה.

לא נבדקו באופן הזה (נבדקים ב-e2e): SearchDialog, HelpPanel.

## רמה A

| קריטריון | סטטוס | הערות | axe |
|---|---|---|---|
| [1.1.1 Non-text Content](https://www.w3.org/WAI/WCAG22/Understanding/non-text-content) | נתמך חלקית | לאייקונים ולכפתורי אייקון יש שמות טקסט (axe). גרפים, תרשימים, הקנבס ומפות שמצוירים מטקסט הפתק הם תמונות: החלופה שלהם היא טקסט המקור בפתק, שתמיד זמין בלחיצה, אבל לתמונה עצמה אין חלופה טקסטואלית. **תוכנית:** לתת לבלוקים של גרפים ותרשימים סיכום טקסט (כותרת, סדרות, ערכים) כשם נגיש, ולקנבס רשימה של הצורות שבו. (0.2.0) | — (axe לא בודק את זה) |
| [1.2.1 Audio-only and Video-only (Prerecorded)](https://www.w3.org/WAI/WCAG22/Understanding/audio-only-and-video-only-prerecorded) | לא רלוונטי | לממשק של Lumen אין שמע או וידאו מוקלטים. מדיה בתוך פתקים היא תוכן של הכותב. | — (axe לא בודק את זה) |
| [1.2.2 Captions (Prerecorded)](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded) | לא רלוונטי | אין בממשק מדיה מוקלטת עם קול. | — (axe לא בודק את זה) |
| [1.2.3 Audio Description or Media Alternative (Prerecorded)](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded) | לא רלוונטי | אין בממשק וידאו מוקלט. | — (axe לא בודק את זה) |
| [1.3.1 Info and Relationships](https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships) | נתמך חלקית | דיאלוגים, תפריטים, הפלטה (combobox ו-listbox), לשוניות, טבלאות וטפסים משתמשים ברכיבים מקוריים או בתפקידי ARIA עם שמות. בעורך, המבנה של השורה שבה הסמן (רמת כותרת, מצב משימה, בלוק קוד, ציטוט) מוקרא. axe (הרצת W3.8) מוצא חריג אחד: ברשת החודש של לוח השנה יש תאים וכותרות עמודה בלי שורות (aria-required-children/-parent, קריטי). **תוכנית:** לתת לרשת של לוח השנה שורות אמיתיות (role=row עם display: contents) ואת כפתור היום בתוך התא — נעשה ב-#522 (W6.30); הרצת axe הבאה אחרי המיזוג תחזיר את זה ל״נתמך״. (0.2.0) | ✗ 6 הפרות: aria-required-children (CalendarPanel, he/light); aria-required-children (CalendarPanel, he/dark); aria-required-children (CalendarPanel, en/light); aria-required-parent (CalendarPanel, he/light) |
| [1.3.2 Meaningful Sequence](https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence) | נתמך | סדר הקריאה הוא סדר ה-DOM בשני הכיוונים; קטעים בעברית ובאנגלית מבודדים, כך שכל אחד נקרא בכיוון שלו. | — (axe לא בודק את זה) |
| [1.3.3 Sensory Characteristics](https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics) | נתמך | ההוראות מציינות את הפקד בשמו („כפתור ההגדרות”, ‏⌘K), אף פעם לא רק לפי צורה, צבע או מיקום. | — (axe לא בודק את זה) |
| [1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color) | נתמך חלקית | הודעות, שגיאות ובחירות מסומנות בטקסט או באייקון עם שם, ולא רק בצבע (כללי הצבע של axe עוברים בשישה מסכים). בשורת המצב, מחווני הסנכרון ושיתוף הפעולה מראים את המצב באייקון ובצבע, והמילים רק ברמז כלי. **תוכנית:** מחווני שורת המצב עם מילה גלויה („מסונכרן”, „לא מקוון”) ושם נגיש, מתורגמים (רמזי הכלים שלהם היום באנגלית בלבד). (0.2.0) | ✓ 1 כללים, 12 בדיקות עברו |
| [1.4.2 Audio Control](https://www.w3.org/WAI/WCAG22/Understanding/audio-control) | נתמך | שום דבר לא מנגן קול מעצמו. הקראה מתחילה רק לפי בקשה, ויש לה כפתור עצירה. | — (axe לא בודק את זה) |
| [2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard) | נתמך חלקית | כל יכולת היא פקודה בפלטה, דיאלוגים שומרים על המיקוד ומחזירים אותו, ואת קצה הסרגל אפשר להזיז בחיצים. את הקנבס (tldraw) והמפה אפשר להזיז ולהגדיל במקלדת, אבל ציור צורות חדשות דורש עכבר. **תוכנית:** פקודות מקלדת להוספה, הזזה וחיבור של צורות בקנבס. (0.2.0) | ✓ 1 כללים, 20 בדיקות עברו |
| [2.1.2 No Keyboard Trap](https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap) | נתמך | ‏Tab בעורך מזיח פנימה (כמו בכל עורך קוד); Escape ואז Tab מוציאים את המיקוד (ההתנהגות של CodeMirror). דיאלוגים משחררים את המיקוד ב-Escape. | — (axe לא בודק את זה) |
| [2.1.4 Character Key Shortcuts](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts) | נתמך | קיצורים גלובליים משתמשים במקש משנה (⌘ / Ctrl / Alt). מקשים בודדים פועלים רק כשרכיב נמצא במיקוד (רשימות, רשת לוח השנה), או במצב Vim, שכבוי עד שמפעילים אותו. | — (axe לא בודק את זה) |
| [2.2.1 Timing Adjustable](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable) | נתמך | לאף משימה אין מגבלת זמן. הודעות שנעלמות מעצמן נשארות כל עוד הסמן מעליהן או המיקוד בתוכן (תוקן לקראת הדוח הזה), ולכל אחת יש כפתור סגירה. | — (axe לא בודק את זה) |
| [2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide) | נתמך | שום תוכן לא זז או מהבהב יותר מחמש שניות, חוץ ממחווני התקדמות בזמן עבודה. עם הגדרת המערכת „הפחתת תנועה”, האנימציות נעצרות. | — (axe לא בודק את זה) |
| [2.3.1 Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold) | נתמך | שום דבר לא מהבהב. | — (axe לא בודק את זה) |
| [2.4.1 Bypass Blocks](https://www.w3.org/WAI/WCAG22/Understanding/bypass-blocks) | נתמך | קישור דילוג קופץ לתוכן הראשי; ציוני דרך (landmarks) נותנים שמות לאזורים. | — (axe לא בודק את זה) |
| [2.4.2 Page Titled](https://www.w3.org/WAI/WCAG22/Understanding/page-titled) | נתמך | כותרת העמוד מציינת את האפליקציה („Lumen — Markdown, illuminated”). היא עדיין לא משתנה לפי הפתק הפתוח: ראו את התוכנית. **תוכנית:** להציג בכותרת העמוד את שם הפתק הפתוח. (0.2.0) | — (axe לא בודק את זה) |
| [2.4.3 Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order) | נתמך | המיקוד נע בסדר הקריאה; דיאלוג לוקח את המיקוד כשהוא נפתח ומחזיר אותו כשהוא נסגר. | — (axe לא בודק את זה) |
| [2.4.4 Link Purpose (In Context)](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context) | נתמך | קישורים בממשק אומרים לאן הם מובילים; קישורי „למידע נוסף” נמצאים בתוך ההודעה שאליה הם שייכים. | ✓ 1 כללים, 20 בדיקות עברו |
| [2.5.1 Pointer Gestures](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures) | נתמך | שום דבר לא דורש מחווה של כמה אצבעות או מסלול: לזום בצביטה בקנבס, במפה ובגרף יש גם כפתורים, גלגלת או מקשים. | — (axe לא בודק את זה) |
| [2.5.2 Pointer Cancellation](https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation) | נתמך | כפתורים פועלים בשחרור (התנהגות מקורית); אפשר לבטל גרירה בחזרה למקום או ב-Escape. | — (axe לא בודק את זה) |
| [2.5.3 Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name) | נתמך חלקית | כפתורים עם טקסט גלוי משתמשים בו כשם. לא כל פקד של אייקון וטקסט נבדק ביד. **תוכנית:** מעבר ידני על כל סרגל כלים ודיאלוג, מתועד בפרוטוקול קוראי המסך. (0.2.0) | — (axe לא בודק את זה) |
| [2.5.4 Motion Actuation](https://www.w3.org/WAI/WCAG22/Understanding/motion-actuation) | לא רלוונטי | אף יכולת לא משתמשת בתנועת המכשיר. | — (axe לא בודק את זה) |
| [3.1.1 Language of Page](https://www.w3.org/WAI/WCAG22/Understanding/language-of-page) | נתמך | תכונת lang של העמוד הולכת לפי שפת הממשק (he,‏ en,‏ ar, …), ו-dir בהתאם. | — (axe לא בודק את זה) |
| [3.2.1 On Focus](https://www.w3.org/WAI/WCAG22/Understanding/on-focus) | נתמך | מיקוד בפקד אף פעם לא משנה את ההקשר. | — (axe לא בודק את זה) |
| [3.2.2 On Input](https://www.w3.org/WAI/WCAG22/Understanding/on-input) | נתמך | שינוי הגדרה מחיל אותה במקום (ערכת נושא, שפה); שום דבר לא עובר עמוד או נשלח בזמן ההקלדה. | — (axe לא בודק את זה) |
| [3.2.6 Consistent Help](https://www.w3.org/WAI/WCAG22/Understanding/consistent-help) | נתמך | העזרה תמיד באותם מקומות: ‏⌘/ מציג את הקיצורים, ובפלטה יש את ההגדרה הראשונית, הצהרת הנגישות, הדוח הזה ודיווח על בעיית נגישות. | — (axe לא בודק את זה) |
| [3.3.1 Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification) | נתמך | שגיאות נכתבות בטקסט ליד השדה, עם role="alert" (למשל תבנית שם לא חוקית לפתק היומי, קובץ ערכת נושא פגום, כניסה שנכשלה). | — (axe לא בודק את זה) |
| [3.3.2 Labels or Instructions](https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions) | נתמך | לכל שדה יש תווית גלויה או שם נגיש, ובמקרה הצורך גם דוגמה. | ✓ 1 כללים, 60 בדיקות עברו |
| [3.3.7 Redundant Entry](https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry) | נתמך | שום תהליך לא מבקש את אותו מידע פעמיים; אשף ההגדרה הראשונית שומר את מה שהוזן כשחוזרים אחורה. | — (axe לא בודק את זה) |
| [4.1.2 Name, Role, Value](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value) | נתמך חלקית | לפקדים מקוריים ולרכיבי ARIA יש שמות, תפקידים ומצבים (axe, בעברית ובאנגלית, בבהיר ובכהה, בשישה מסכים). הקנבס והמפה הם רכיבי צד שלישי עם תפקידים חלקיים. **תוכנית:** להרחיב את בדיקת axe לכל פאנל ודיאלוג, ולעטוף את הקנבס והמפה באזורים עם תוויות ותקציר למקלדת. (0.2.0) | ✓ 18 כללים, 1,528 בדיקות עברו |

## רמה AA

| קריטריון | סטטוס | הערות | axe |
|---|---|---|---|
| [1.2.4 Captions (Live)](https://www.w3.org/WAI/WCAG22/Understanding/captions-live) | לא רלוונטי | אין בממשק שמע או וידאו חיים (שיתוף הפעולה הוא בטקסט בלבד). | — (axe לא בודק את זה) |
| [1.2.5 Audio Description (Prerecorded)](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-prerecorded) | לא רלוונטי | אין בממשק וידאו מוקלט. | — (axe לא בודק את זה) |
| [1.3.4 Orientation](https://www.w3.org/WAI/WCAG22/Understanding/orientation) | נתמך | עובד לאורך ולרוחב; שום דבר לא נועל את הכיוון. | — (axe לא בודק את זה) |
| [1.3.5 Identify Input Purpose](https://www.w3.org/WAI/WCAG22/Understanding/identify-input-purpose) | נתמך | שדות של מידע אישי משתמשים ב-autocomplete: ‏email,‏ current-password ו-new-password בכניסה. | ✓ 1 כללים, 12 בדיקות עברו |
| [1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum) | נתמך חלקית | טקסט רגיל, פקדים וערכות הנושא המובנות עומדים ב-4.5:1 במצב בהיר וכהה. axe (הרצת W3.8) מוצא טקסט סטטוס מתחת לזה: תג הפרטיות בשורת המצב, אזהרת האחסון בהיסטוריית הגרסאות, הערה בסיור ההיכרות ובהגדרות שיתוף הפעולה במצב כהה (11 תוצאות ב-5 משטחים), כולם בצבעי המילוי --success/--warning ‏(3.0–3.6:1). **תוכנית:** לצבוע טקסט סטטוס בטוקני הטקסט --ok/--warn ‏(≥ 4.5:1) במקום טוקני המילוי — נעשה ב-#522 (W6.30); להריץ axe שוב אחרי המיזוג. (0.2.0) | ✗ 11 הפרות: color-contrast (StatusBar, he/light); color-contrast (StatusBar, en/light); color-contrast (OnboardingTour, he/dark); color-contrast (CollabSettings, he/dark) |
| [1.4.4 Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text) | נתמך | הטקסט גדל עד 200% בזום של הדפדפן בלי לאבד תוכן או פונקציה. | — (axe לא בודק את זה) |
| [1.4.5 Images of Text](https://www.w3.org/WAI/WCAG22/Understanding/images-of-text) | נתמך | הממשק משתמש בטקסט אמיתי, לא בתמונות של טקסט. | — (axe לא בודק את זה) |
| [1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow) | נתמך | ברוחב 320 פיקסלים (זום 400%) המסך הראשי, הפאנלים הצדדיים והדיאלוגים נכנסים בלי גלילה לרוחב. בלוקי קוד וטבלאות נגללים בתוך התיבה שלהם (מותר לתוכן דו-ממדי). | — (axe לא בודק את זה) |
| [1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast) | נתמך חלקית | טבעות מיקוד, צבע ההדגשה ואייקונים עומדים ב-3:1. בערכת ברירת המחדל הגבולות של חלק משדות הטקסט בהירים מ-3:1 מול הרקע; ערכת „ניגודיות גבוהה” עומדת בזה בכל מקום. **תוכנית:** להכהות את גבולות השדות (‎--border-strong לשדות) ל-3:1 בכל ערכה, ולהוסיף את הבדיקה לדוח הניגודיות. (0.2.0) | — (axe לא בודק את זה) |
| [1.4.12 Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing) | נתמך חלקית | הפריסות משתמשות בתיבות גמישות ואמורות לעמוד בהגדרות ריווח הטקסט של WCAG, אבל זה עוד לא נבדק אוטומטית. **תוכנית:** בדיקת e2e שמחילה את סגנונות ריווח הטקסט של WCAG על עשרה מסכים ובודקת שדבר לא נחתך. (0.2.0) | ✓ 1 כללים, 144 בדיקות עברו |
| [1.4.13 Content on Hover or Focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus) | נתמך חלקית | רוב רמזי הכלים הם של הדפדפן (title). תצוגות מקדימות של קישורים וחלק מהחלוניות הקופצות מופיעים בריחוף; לא את כולם אפשר לסגור ב-Escape בלי להזיז את הסמן. **תוכנית:** רכיב חלונית קופצת אחד: נסגר ב-Escape, אפשר לרחף מעליו, ונשאר עד שסוגרים. (0.2.0) | — (axe לא בודק את זה) |
| [2.4.5 Multiple Ways](https://www.w3.org/WAI/WCAG22/Understanding/multiple-ways) | נתמך | אפשר להגיע לפתקים מעץ הקבצים, מהחיפוש, מפלטת הפקודות (פתיחה מהירה), מקישורים חוזרים, מתגיות ומהגרף. | — (axe לא בודק את זה) |
| [2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels) | נתמך | לדיאלוגים ולפאנלים יש כותרות; לשדות יש תוויות שאומרות למה הם. | — (axe לא בודק את זה) |
| [2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible) | נתמך | לכל רכיב שאפשר להתמקד בו יש טבעת מיקוד, גם במצב צבעים מאולצים. | — (axe לא בודק את זה) |
| [2.4.11 Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum) | נתמך חלקית | דיאלוגים הם מודאליים וממורכזים. הודעות בפינה יכולות לכסות פקד במיקוד ליד הקצה התחתון עד שהן נעלמות. **תוכנית:** להזיז הודעות מהרכיב שבמיקוד, ובדיקת e2e שעוברת ב-Tab על המסך הראשי כשמוצגות הודעות. (0.2.0) | — (axe לא בודק את זה) |
| [2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements) | נתמך חלקית | סידור לשוניות המסמכים מחדש נעשה רק בגרירה; עדיין אין חלופה של לחיצה או פקודה. לגרירות אחרות (קצה הסרגל) יש חלופה במקלדת, אבל לא בלחיצה בודדת. **תוכנית:** „הזזת לשונית ימינה / שמאלה” בתפריט הלשונית ובפלטה, ותפריט רוחב על קצה הסרגל. (0.2.0) | — (axe לא בודק את זה) |
| [2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) | נתמך חלקית | רוב הפקדים בגודל 24×24 פיקסלים לפחות, או מרווחים כך שעיגול של 24 פיקסלים נכנס. כמה כפתורי אייקון בפאנלים צפופים (החיצים של לוח השנה, כפתור הסגירה של הודעה) קטנים יותר. axe (הרצת W3.8) מאשר: 13 תוצאות בכפתורי הסגירה של הלשוניות, בסגירה של חלון הצפנת הכספת, בכותרת לוח השנה ובחלונית השימושיות. **תוכנית:** להגדיל את הכפתורים האלה ל-24 פיקסלים — נעשה ב-#522 (W6.30) — ולהשאיר את כלל target-size של axe בהרצה. (0.2.0) | ✗ 13 הפרות: target-size (DocTabs, en/light); target-size (VaultEncryptionDialog, he/light); target-size (CalendarPanel, he/light); target-size (VaultEncryptionDialog, he/dark) |
| [3.1.2 Language of Parts](https://www.w3.org/WAI/WCAG22/Understanding/language-of-parts) | נתמך | טקסט הממשק בשפת הממשק. עברית שמוצגת בממשק באנגלית (שמות החודשים העבריים בלוח השנה) מסומנת lang="he". בפתקים, השפה של כל חלק היא של הכותב. | ✓ 1 כללים, 6 בדיקות עברו |
| [3.2.3 Consistent Navigation](https://www.w3.org/WAI/WCAG22/Understanding/consistent-navigation) | נתמך | שורת הכותרת, הסרגל, שורת המצב והפלטה באותו מקום בכל מסך. | — (axe לא בודק את זה) |
| [3.2.4 Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification) | נתמך | לאותה פונקציה יש אותו שם ואותו אייקון בכל מקום (פקודות, תפריטים וכפתורים חולקים את אותן מחרוזות). | — (axe לא בודק את זה) |
| [3.3.3 Error Suggestion](https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion) | נתמך | הודעות שגיאה אומרות איך לתקן („התבנית חייבת לכלול YYYY,‏ MM ו-DD”). | — (axe לא בודק את זה) |
| [3.3.4 Error Prevention (Legal, Financial, Data)](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data) | נתמך | מחיקת פתק מעבירה אותו לאשפה, ומשם אפשר לשחזר אותו; תשלומים נעשים בעמוד של ספק התשלומים. | — (axe לא בודק את זה) |
| [3.3.8 Accessible Authentication (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum) | נתמך | הכניסה לא דורשת מבחן קוגניטיבי: שדות הדוא״ל והסיסמה מאפשרים הדבקה ומנהלי סיסמאות (autocomplete), או כניסה דרך ספק SSO. | — (axe לא בודק את זה) |
| [4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages) | נתמך | ההודעות נמצאות באזורי live שתמיד בעמוד (role="status", ושגיאות role="alert"; תוקן לקראת הדוח הזה), והעורך מקריא את השינויים שלו דרך אזורי ה-live המשותפים. | — (axe לא בודק את זה) |

## חריגים ותוכנית תיקון

כל קריטריון שאינו נתמך במלואו, ומה ייעשה לגביו:

- **1.1.1 Non-text Content** (A, נתמך חלקית): לתת לבלוקים של גרפים ותרשימים סיכום טקסט (כותרת, סדרות, ערכים) כשם נגיש, ולקנבס רשימה של הצורות שבו. יעד: 0.2.0.
- **1.3.1 Info and Relationships** (A, נתמך חלקית): לתת לרשת של לוח השנה שורות אמיתיות (role=row עם display: contents) ואת כפתור היום בתוך התא — נעשה ב-#522 (W6.30); הרצת axe הבאה אחרי המיזוג תחזיר את זה ל״נתמך״. יעד: 0.2.0.
- **1.4.1 Use of Color** (A, נתמך חלקית): מחווני שורת המצב עם מילה גלויה („מסונכרן”, „לא מקוון”) ושם נגיש, מתורגמים (רמזי הכלים שלהם היום באנגלית בלבד). יעד: 0.2.0.
- **2.1.1 Keyboard** (A, נתמך חלקית): פקודות מקלדת להוספה, הזזה וחיבור של צורות בקנבס. יעד: 0.2.0.
- **2.4.2 Page Titled** (A, נתמך): להציג בכותרת העמוד את שם הפתק הפתוח. יעד: 0.2.0.
- **2.5.3 Label in Name** (A, נתמך חלקית): מעבר ידני על כל סרגל כלים ודיאלוג, מתועד בפרוטוקול קוראי המסך. יעד: 0.2.0.
- **4.1.2 Name, Role, Value** (A, נתמך חלקית): להרחיב את בדיקת axe לכל פאנל ודיאלוג, ולעטוף את הקנבס והמפה באזורים עם תוויות ותקציר למקלדת. יעד: 0.2.0.
- **1.4.3 Contrast (Minimum)** (AA, נתמך חלקית): לצבוע טקסט סטטוס בטוקני הטקסט --ok/--warn ‏(≥ 4.5:1) במקום טוקני המילוי — נעשה ב-#522 (W6.30); להריץ axe שוב אחרי המיזוג. יעד: 0.2.0.
- **1.4.11 Non-text Contrast** (AA, נתמך חלקית): להכהות את גבולות השדות (‎--border-strong לשדות) ל-3:1 בכל ערכה, ולהוסיף את הבדיקה לדוח הניגודיות. יעד: 0.2.0.
- **1.4.12 Text Spacing** (AA, נתמך חלקית): בדיקת e2e שמחילה את סגנונות ריווח הטקסט של WCAG על עשרה מסכים ובודקת שדבר לא נחתך. יעד: 0.2.0.
- **1.4.13 Content on Hover or Focus** (AA, נתמך חלקית): רכיב חלונית קופצת אחד: נסגר ב-Escape, אפשר לרחף מעליו, ונשאר עד שסוגרים. יעד: 0.2.0.
- **2.4.11 Focus Not Obscured (Minimum)** (AA, נתמך חלקית): להזיז הודעות מהרכיב שבמיקוד, ובדיקת e2e שעוברת ב-Tab על המסך הראשי כשמוצגות הודעות. יעד: 0.2.0.
- **2.5.7 Dragging Movements** (AA, נתמך חלקית): „הזזת לשונית ימינה / שמאלה” בתפריט הלשונית ובפלטה, ותפריט רוחב על קצה הסרגל. יעד: 0.2.0.
- **2.5.8 Target Size (Minimum)** (AA, נתמך חלקית): להגדיל את הכפתורים האלה ל-24 פיקסלים — נעשה ב-#522 (W6.30) — ולהשאיר את כלל target-size של axe בהרצה. יעד: 0.2.0.

## הוסר ב-WCAG 2.2

- 4.1.1 Parsing: הוסר ב-WCAG 2.2 (תמיד מתקיים ב-HTML).

## פנייה בנושא נגישות

נתקלתם בחסם? פתחו [דיווח נגישות](https://github.com/talstilkol/lumen-md/issues/new?template=accessibility.yml) (טופס עם התווית **accessibility**), או בחרו **דיווח על בעיית נגישות** בפלטת הפקודות. דיווחי נגישות מטופלים לפני באגים אחרים. ראו גם את [הצהרת הנגישות](/he/editor/accessibility-statement/).
