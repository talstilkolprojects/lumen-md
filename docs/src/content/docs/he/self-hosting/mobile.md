---
title: בניית Android ו-iOS
description: איך ה-APK ל-Android וה-IPA ל-iOS נבנים בכל pull request, מה לא חתום עד שיש חשבונות בחנויות, ואילו secrets חותמים עליהם.
---

האפליקציות של Lumen לנייד הן אותו build של הווב עטוף ב-Capacitor: `android/`
ו-`ios/App/` הם שלדי פרויקט שמחויבים לריפו, ו-`npx cap sync` מעתיק את
`dist/` לתוכם. `.github/workflows/mobile.yml` בונה את שניהם בכל pull request,
כך ששינוי שמקלקל את הפרויקטים הנייטיב מתגלה לפני המיזוג.

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
