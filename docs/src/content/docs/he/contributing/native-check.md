---
title: קומפילציה של הקוד ה-native בלי רשת
description: איך הקוד של Lumen ב-Rust, ב-Java וב-Swift מקומפל בלי crates.io, בלי Android SDK ובלי Xcode — מה הבדיקה מוכיחה, מה לא, ומה עדיין דורש Mac.
---

ל-Lumen יש קוד native לצד אפליקציית הרשת: מעטפת שולחן העבודה של Tauri
ב-`src-tauri/` ‏(Rust), התוספים והווידג׳ט של Android ‏(Java), וההרחבות של iOS
‏(Swift). בנייה מלאה צריכה את crates.io, את קובצי הכותרת של WebKitGTK, את
Android SDK עם מאגר ה-Maven של Google, או Xcode. כשאף אחד מהם לא זמין (סביבה
בלי רשת, טיסה, רשת חסומה), מריצים:

```sh
bash tools/native-check/run.sh
```

צריך רק `rustc` ו-`javac` ‏(JDK 17 ומעלה), וזה נגמר בתוך כעשר שניות.

## מה נבדק

| שלב | מה רץ | מה הצלחה מוכיחה |
|---|---|---|
| 1. crates בלי תלויות | `rustc --test` על `src-tauri/desktop`, `keychain`, `vault`, `src/whisper_core.rs` | הקוד מתקמפל ובדיקות היחידה שלו עוברות — באמת, בלי stubs. |
| 2. ה-glue של Tauri | `rustc` על `src-tauri/src/lib.rs` ו-`main.rs` מול `tools/native-check/rust-stubs/`, פעם עם `--cfg desktop` ופעם עם `--cfg mobile` | כל מודול, import, טיפוס, השאלה ו-lifetime תקינים מול החתימות של tauri 2 והתוספים שלו. |
| 2. פקודות | ה-`#[tauri::command]` המדומה | כל ארגומנט הוא ארגומנט פקודה (Deserialize,‏ `State`,‏ `AppHandle`,‏ `Window`,‏ `Request`), כל ערך מוחזר הוא תשובת IPC, ה-future של כל פקודה אסינכרונית הוא `Send`, ופקודה אסינכרונית שמשאילה מחזירה `Result` — הכללים שהמאקרו האמיתי אוכף. |
| 2. ‏Cargo.lock | `lockcheck.mjs` | כל תלות ב-`Cargo.toml` נמצאת ב-`Cargo.lock`: ‏`cargo check --locked` לא יסרב. |
| 3. ‏Android | `javac -Xlint:all -Werror` על `android/app/src/main/java` ו-`mobile/android` מול `java-stubs/`, עם מחלקת `R` שנוצרת מ-`res/` | ה-Java מתקמפל בלי אזהרות; כל הפניה ל-`@string`,‏ `@xml`,‏ `@layout`,‏ `@drawable`,‏ `@mipmap` ו-`@style` קיימת. |
| 4. ‏Swift | רק רשימה | כלום: Swift צריך Xcode. |

## ‏cargo אמיתי, בלי הורדת crates

‏`Cargo.toml` נבדק גם למפתח או ל-`[table]` שנכתבו פעמיים: ‏cargo מסרב לקובץ כזה
("duplicate key") עוד לפני שהוא פותר תלויות, ו-rustc מול stubs לא רואה את זה.

כשאפשר להגיע לאינדקס של crates.io דרך git אבל לא להוריד crates, ה-cargo האמיתי
עדיין מריץ את מפענח ה-manifest, את פותר התלויות, את בדיקת ה-features ואת כלל
`--locked`:

```bash
git clone --depth 1 https://github.com/rust-lang/crates.io-index ~/crates.io-index   # כ-8 GB אחרי checkout
NATIVE_CHECK_INDEX=~/crates.io-index bash tools/native-check/run.sh
```

‏`real-cargo.sh` מכוון `CARGO_HOME` זמני אל השיבוט כ-local registry, על עותק של
`src-tauri/`. כל crate מקומי בלי תלויות (`desktop/`) מקומפל ונבדק על ידי cargo.
‏`cargo check --locked` מדווח **ok** רק כשהוא מקמפל. בלי קוד המקור של ה-crates הוא
עוצר בהורדה הראשונה של crate: זה מדווח **UNKNOWN** והסקריפט יוצא בקוד 3 (ו-`run.sh`
מסתיים ב-"native check: UNKNOWN"). ה-manifest, ה-resolver ו-`Cargo.lock` נקראו,
אבל שום דבר לא קומפל, אז זה לא מעבר.

## מה הבדיקה לא יכולה להוכיח

ה-stubs מכילים חתימות, לא התנהגות. הם הועתקו מ-tauri 2 ומקוד המקור של
התוספים (tauri-plugin-dialog,‏ ‎-deep-link,‏ ‎-single-instance,‏ ‎-updater,‏
‎-fs) בגרסאות שב-`Cargo.lock`. stub יכול לטעות, וכשהקוד משתמש ב-API שאין
ב-stubs, מוסיפים אותו שם **מהמקור האמיתי** — אף פעם לא כדי להעלים שגיאה.
אלה עדיין צריכים את הכלים האמיתיים:

- ‏`cargo check --locked` / ‏`npm run tauri:build` (צריך crates.io, וב-Linux גם
  `libwebkit2gtk-4.1-dev`,‏ `libgtk-3-dev`,‏ `libayatana-appindicator3-dev`);
- קוד תחת `#[cfg(target_os = "macos")]` או `"windows"` (מחזיק המפתחות,
  ‏`RunEvent::Opened` של macOS): הבדיקה רצה רק ליעד Linux;
- ‏`./gradlew assembleDebug` ב-`android/` ‏(Android SDK ו-Maven של Google);
- קובצי ה-Swift ויעדי הווידג׳ט וה-intents: ‏Xcode על Mac
  (ראו [בניית Android ו-iOS](/he/self-hosting/mobile/)).

## כשהבדיקה נכשלת

כל כשל מציין קובץ ושורה, כפי ש-`rustc` ו-`javac` מדפיסים. כשל בשלב 2 שמזכיר
פריט של tauri שאין ב-stubs ‏(`no method named … found`) הוא באג אמיתי או stub
חסר: בודקים את הפריט בקוד המקור של tauri בגרסה שב-`Cargo.lock` לפני שמשנים
צד כלשהו.
