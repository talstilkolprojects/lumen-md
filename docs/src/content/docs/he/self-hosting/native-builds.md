---
title: בנייה native במארחים חינמיים
description: איך אפליקציית שולחן העבודה, ה-AAB ל-Android וה-IPA ל-iOS מקומפלים באמת בלי GitHub Actions — סקריפט Linux למארח השני, הדקות החינמיות של Codemagic ב-macOS, והרצת robo ב-Firebase Test Lab או ב-BrowserStack.
---

תוכנית W6.24. הקוד ה-native ‏(Rust ב-`src-tauri/`, ‏Java ב-`android/`, ‏Swift
ב-`ios/`) מקומפל בכלים שלו — `cargo`, ‏Gradle ו-Xcode — במארחים שלא עולים כסף.
שום דבר לא רץ ב-push: כל בנייה מתחילה ידנית.

## שולחן עבודה ב-Linux: ‏`scripts/native/linux-build.sh`

ב-Ubuntu 24.04 (המארח השני של מפעל האימות, VM או קונטיינר):

```bash
bash scripts/native/linux-build.sh --install   # פעם אחת: WebKitGTK, rustup, Node 22, JDK 21, Android SDK
bash scripts/native/linux-build.sh             # npm run build, cargo check --locked, cargo test, tauri build, Gradle
bash scripts/native/linux-build.sh --updater-bump   # גם tauri-plugin-updater 2.14.1 (zip 9)
bash scripts/native/linux-build.sh --dry-run   # רק הפקודות
```

- `cargo check --locked` מסרב ל-`Cargo.lock` שלא תואם ל-`Cargo.toml`; הסקריפט
  אף פעם לא מעדכן את הנעילה בשקט.
- `tauri::generate_context!()` מטמיע את `dist/`, ולכן בניית הווב רצה קודם.
- `--updater-bump` שומר את הנעילה החדשה רק אם `cargo check --locked` עדיין עובר.
- **Android דורש x86-64.** גוגל לא מפיצה כלי בנייה של Android ל-Linux על ARM
  ("Linux machines with ARM-based CPUs aren't currently supported",
  developer.android.com/studio/install). במארח Oracle Ampere שלב Gradle מדולג
  ומוסבר; מריצים אותו על x86-64, על ה-Mac או ב-Codemagic.
- הסיכום נכתב ל-`reports/native/<commit>.txt`.

## טלפונים ו-macOS: ‏Codemagic

ב-`codemagic.yaml` יש את ה-workflows האלה (Codemagic ← האפליקציה ← Start new build):

| Workflow | מה הוא עושה |
| --- | --- |
| `mobile-release` | AAB חתום ו-IPA חתום **מאותו קומיט**; ה-AAB למסלול הפנימי של Play, ה-IPA ל-TestFlight; ‏`BUILD-INFO.txt` ו-`SHA256SUMS` מציינים את הקומיט |
| `android-robo` | ה-APK של debug ב-robo של Firebase Test Lab; עם `LUMEN_SMOKE=browserstack` — בדיקת ההפעלה של Espresso ב-BrowserStack |
| `desktop-macos` | ‏`cargo check --locked` ו-`tauri build` ל-macOS |
| `ios-testflight`, ‏`android-aab` | פלטפורמה אחת כל אחד (תוכנית W4.22) |

המסלול החינמי (codemagic.io/pricing, נבדק 14.11.2026): ‏500 דקות macOS M2 בחודש,
בנייה אחת בכל פעם, 120 דקות לבנייה, משתמש אחד. המפתחות נשמרים בקבוצות משתנים
של Codemagic ‏(`lumen_ios`, ‏`lumen_android`, ‏`lumen_play`, ‏`lumen_testlab`,
‏`lumen_browserstack`); בריפו מופיעים רק השמות שלהם.

## הרצת robo בלי טלפון

```bash
npm run mobile:android -- --unsigned
FIREBASE_PROJECT=<id> bash scripts/mobile-device-smoke.sh testlab   # 2 מכשירים וירטואליים, עברית ואנגלית
bash scripts/mobile-device-smoke.sh testlab --physical              # מכשיר פיזי אחד
```

המכשירים מוגדרים ב-`mobile/testlab/robo.yaml`. מסלול Spark החינמי מאפשר 10 הרצות
וירטואליות ו-5 פיזיות ביום. **‏Firebase Test Lab נסגר ב-30 בספטמבר 2027**
(firebase.google.com/docs/test-lab/usage-quotas-pricing), ולכן החלופה היא BrowserStack App Automate:

```bash
(cd android && ./gradlew assembleDebugAndroidTest)
BROWSERSTACK_USERNAME=… BROWSERSTACK_ACCESS_KEY=… bash scripts/mobile-device-smoke.sh browserstack
```

היא מריצה את `LaunchSmokeTest` (האפליקציה עולה וה-WebView שלה נטען עד 100%) על
שני טלפוני Android אמיתיים. תקופת הניסיון של BrowserStack כוללת 100 דקות App Automate.
