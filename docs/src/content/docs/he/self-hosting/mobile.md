---
title: בניית Android ו-iOS
description: איך ה-APK ל-Android וה-IPA ל-iOS נבנים בכל pull request, מה לא חתום עד שיש חשבונות בחנויות, ואילו secrets חותמים עליהם.
---

האפליקציות של Lumen לנייד הן אותו build של הווב עטוף ב-Capacitor: `android/`
ו-`ios/App/` הם שלדי פרויקט שמחויבים לריפו, ו-`npx cap sync` מעתיק את
`dist/` לתוכם. `.github/workflows/mobile.yml` בונה את שניהם בכל pull request,
כך ששינוי שמקלקל את הפרויקטים הנייטיב מתגלה לפני המיזוג.

## פקודה אחת במחשב שלכם (משימה W4.22)

GitHub Actions כבויים בריפו הזה (החלטת הבעלים, 9.11). לכן לבניות המובייל יש
גם פקודה מקומית אחת לכל פלטפורמה. ה-workflow שמתואר למטה נשאר לזמן ש-Actions
יופעלו.

```bash
npm run mobile:check                                   # מה חסר לכל פלטפורמה, ואיך לתקן
npm run mobile:android -- --version 0.2.0-beta.1       # AAB חתום + APK חתום + APK של debug ← release/mobile/
npm run mobile:ios -- --version 0.2.0-beta.1           # ב-Mac: ארכיון, העלאה, TestFlight
```

שתי הפקודות מתחילות בבדיקה מקדימה. היא מציגה כל כלי, מפתח או הגדרה שחסרים,
ולצד כל אחד את הפקודה המדויקת שמתקנת אותו, ונעצרת לפני הבנייה. ‏`--dry-run`
מדפיס את הפקודות בלי להריץ אותן. ברירת המחדל של `--version` היא הגרסה
ב-`package.json`.

**מספרי build.** שתי החנויות דורשות מספר שגדל בכל העלאה. המספר נגזר מהגרסה:
major·10⁶ + minor·10⁴ + patch·10² + מספר הבטא (99 לגרסה היציבה). למשל
0.2.0-beta.1 ← 20001, ‏0.2.0-beta.2 ← 20002, ו-0.2.0 ← 20099. ב-Android הוא
`versionCode`. ב-iOS הוא `CURRENT_PROJECT_VERSION`, ו-`MARKETING_VERSION` הוא
0.2.0, כי iOS לא מקבל `-beta` בגרסה.

### Android

1. בניית הווב (`VITE_LUMEN_CHANNEL=beta` בבטא), ואז `npx cap sync android`.
2. ‏Gradle מריץ `assembleDebug bundleRelease assembleRelease` עם `-PversionCode` / `-PversionName`.
3. בדיקות: ה-AAB נבדק ב-`jarsigner` וה-APK ב-`apksigner`. חבילה שנחתמה
   במפתח debug ‏(`CN=Android Debug`) נדחית, כי Play היה דוחה אותה.
4. פלט: `release/mobile/lumen-<v>.aab` (ל-Play), ‏`lumen-<v>.apk` (התקנה
   ישירה), ‏`lumen-<v>-debug.apk` (אמולטור ו-Firebase Test Lab), ו-`SHA256SUMS`.

צריך: JDK 21, ‏Android SDK עם `platforms;android-36` ‏(`ANDROID_HOME`), ואת
ה-keystore להעלאה ב-`ANDROID_KEYSTORE_PATH`, ‏`ANDROID_KEYSTORE_PASSWORD`,
‏`ANDROID_KEY_ALIAS` ו-`ANDROID_KEY_PASSWORD`. יוצרים את ה-keystore פעם אחת:

```bash
keytool -genkeypair -v -keystore ~/.lumen-android/upload.jks -alias lumen -keyalg RSA -keysize 4096 -validity 10000
```

שמרו אותו ואת הסיסמה במנהל הסיסמאות. עם Play App Signing מפתח האפליקציה נשמר
אצל Google, וזה רק מפתח ההעלאה, כך שאפשר להחליף אותו אם הוא אובד. את ה-AAB
הראשון מעלים ב-Play Console ‏(*Testing ← Internal testing*). ‏`--unsigned`
בונה רק את ה-APK של debug, בלי keystore.

### iOS ← TestFlight

1. בניית הווב, ואז `npx cap sync ios`.
2. ‏`xcodebuild archive` רץ עם **חתימה אוטומטית דרך מפתח ה-API של App Store
   Connect** ‏(`-allowProvisioningUpdates -authenticationKeyPath …`), ולכן Xcode
   יוצר את תעודת ההפצה ואת הפרופיל, או משתמש בקיימים. אין קובץ `.p12` ואין
   פרופיל לייצא ביד.
3. ‏`xcodebuild -exportArchive` רץ עם `exportOptions.plist` שנוצר לכל build
   (שיטה `app-store-connect`, יעד `upload`), ומעלה ל-App Store Connect. בטא
   מסומנת לבדיקה פנימית בלבד.
4. ‏App Store Connect מעבד את ה-build תוך 10–30 דקות. אחר כך הוא מופיע
   ב-**TestFlight ← Internal Testing** לצוות.

‏`--altool` מייצא קובץ `.ipa` ומעלה אותו במקום זה עם
`xcrun altool --upload-app … --apiKey --apiIssuer`. Apple סימנה את
`--upload-app` כמיושן לטובת `--upload-package`, אבל הוא עדיין עובד.
‏`--no-upload` רק משאיר את `release/mobile/lumen-<v>.ipa`.

צריך: Mac עם Xcode 16 ומעלה, ואת `APPLE_TEAM_ID`, ‏`ASC_KEY_ID`
ו-`ASC_ISSUER_ID`. צריך גם את קובץ המפתח: `ASC_KEY_PATH` מצביע על
`AuthKey_<id>.p8`, או ש-`ASC_KEY` מכיל את הטקסט שלו. יוצרים את המפתח
ב-App Store Connect ← Users and Access ← Integrations ← App Store Connect API,
עם התפקיד **Admin**, כדי ש-Xcode יוכל לנהל תעודות. את קובץ ה-`.p8` אפשר להוריד
רק פעם אחת. רשומת האפליקציה (`com.lumen.editor`) צריכה להיות קיימת ב-App Store
Connect. כל עוד `ITSAppUsesNonExemptEncryption` לא מוגדר ב-`Info.plist` (ראו
`store/SUBMISSION.md`), ‏App Store Connect שואל בכל build את שאלת בקרת היצוא.

### בלי Mac ובלי Android SDK:‏ Codemagic

‏`codemagic.yaml` מריץ את אותן שתי פקודות על מכונות macOS M2 של Codemagic.
אין בו סעיף `triggering:`, ולכן שום build לא מתחיל ב-push. מפעילים כל build
ביד בממשק של Codemagic. ב-12.11.2026 עמוד המחירים של Codemagic אמר
ש**לחשבון אישי יש 500 דקות macOS M2 בחינם בחודש**, שמתאפסות ב-1 לחודש. הוא
גם אמר שאין דקות חינם ב-Linux או ב-Windows, ואין דקות חינם ל-Teams. לכן שני
ה-workflows משתמשים ב-Mac, ו-build של iOS ‏(15–25 דקות בערך) נכנס הרבה פעמים
בחודש. קבוצות הסביבה `lumen_ios` ו-`lumen_android` מחזיקות את אותם משתנים
שלמעלה (ה-keystore בתור `ANDROID_KEYSTORE_BASE64`). בדקו את התנאים העדכניים
ב-docs.codemagic.io/billing/pricing לפני שסומכים עליהם.

### בדיקת עשן בלי טלפון

- **Android:** הרצת robo של APK ה-debug ב-Firebase Test Lab
  (`gcloud firebase test android run --type robo --app release/mobile/lumen-<v>-debug.apk --device model=<id>,version=<api>`).
  היא בחינם בתוכנית Spark (ראו *ישיבות הבעלים* 1.6). אפשר גם אמולטור
  מ-Android Studio.
- **iOS:** ‏TestFlight במכשיר של טל, או BrowserStack App Live עם קובץ
  ה-`.ipa` (תוכנית הקוד הפתוח).

## מה כל pull request מייצר

| job | runner | ארטיפקט | חתום? |
|---|---|---|---|
| Android APK | `ubuntu-24.04`, Temurin 21, Android SDK 36 | `lumen-android`: `app-debug.apk` (מפתח debug, מותקן על מכשיר מפתח) ו-`app-release-unsigned.apk` | debug: כן (מפתח debug) · release: רק עם ה-secrets של ה-keystore |
| iOS IPA | `macos-14`, Xcode | `lumen-ios`: `Lumen-unsigned.ipa` | רק עם ה-secrets של התעודה והפרופיל |

בלי חשבונות בחנויות (פעולה 15.7) שני ה-jobs נשארים ירוקים והארטיפקטים לא
חתומים: הם מוכיחים שהפרויקטים הנייטיב מתקמפלים מול ה-build הנוכחי של הווב.
IPA לא חתום לא מותקן בשום מקום; APK של debug מותקן על כל מכשיר Android במצב
מפתח.

מקומית: `npm run android:open` / `npm run ios:open` בונים את אפליקציית
הווב, מסנכרנים אותה לפרויקט הנייטיב ופותחים Android Studio / Xcode.

## חתימה (secrets אופציונליים)

הגדירו את ה-secrets האלה בריפו ואותם jobs יחתמו על ארטיפקטי ה-release;
צינור השחרור (משימה 13.4) מפרסם אותם.

| secret | מה |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | ה-keystore של ה-release, ב-base64 (`base64 -w0 release.keystore`) |
| `ANDROID_KEYSTORE_PASSWORD` | הסיסמה שלו |
| `ANDROID_KEY_ALIAS` | ה-alias של המפתח בתוכו |
| `ANDROID_KEY_PASSWORD` | סיסמת המפתח |
| `IOS_CERTIFICATE_P12_BASE64` | תעודת ההפצה עם המפתח הפרטי שלה, כ-`.p12`, ב-base64 |
| `IOS_CERTIFICATE_PASSWORD` | סיסמת ה-`.p12` |
| `IOS_PROVISIONING_PROFILE_BASE64` | פרופיל ה-provisioning ל-App Store עבור `com.lumen.editor`, ב-base64 |
| `IOS_PROVISIONING_PROFILE_NAME` | שמו, כפי שמופיע בפורטל המפתחים של Apple |
| `APPLE_TEAM_ID` | מזהה הצוות |

`android/app/build.gradle` קורא את ה-keystore מ-`ANDROID_KEYSTORE_PATH`
(ה-workflow מפענח את ה-secret לשם) וחותם על build ה-release רק כשהוא
מוגדר; שום דבר בריפו לא מחזיק חומר מפתחות. הייצוא ל-iOS משתמש
ב-`ios/exportOptions.plist` (שיטה `app-store-connect`) עם הצוות והפרופיל
ממולאים מה-secrets.

גרסאות: `./gradlew -PversionCode=42 -PversionName=1.2.0` קובע את גרסת
Android; גרסת iOS היא `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`
בפרויקט ה-Xcode. צינור השחרור קובע את שתיהן מהתג.

## Safari ואחסון

Safari מוחק את האחסון של אתר אחרי שבעה ימים בלי ביקור, ומעניק
`navigator.storage.persist()` רק לאפליקציות מותקנות. כשהכספת לא נשמרת
ב-Safari או בכל דפדפן ב-iOS, ו-Lumen לא מותקנת ולא האפליקציה הנייטיב,
מוצגת תזכורת פעם בשבוע: לייצא את הכספת, או להוסיף את Lumen למסך הבית /
ל-Dock, שם האחסון נשמר. האפליקציות הנייטיב שומרות את האחסון שלהן כמו כל
אפליקציה.
