---
title: התקנה דרך מנהל חבילות
description: התקנת אפליקציית שולחן העבודה של לומן עם Homebrew,‏ winget,‏ Flatpak או AUR, ומאיפה החבילות האלה מגיעות.
---

כל גרסה של אפליקציית שולחן העבודה מתפרסמת כגרסה ב־GitHub. ה־cask של
Homebrew, קובצי winget, קובץ Flathub וחבילת AUR נוצרים כולם מקובץ
`SHA256SUMS` של אותה גרסה, כך שכל ערוץ מתקין את אותם קבצים.

| מערכת | פקודה |
|---|---|
| ‏macOS ‏(Homebrew) | ‏`brew install --cask lumen-md` |
| ‏Windows ‏(winget) | ‏`winget install Talstilkol.Lumen` |
| ‏Linux ‏(Flathub) | ‏`flatpak install flathub io.github.talstilkol.Lumen` |
| ‏Arch Linux ‏(AUR) | ‏`yay -S lumen-md-bin` (או כל כלי AUR אחר) |

ערוץ עובד אחרי שהבעלים הגיש אליו את הגרסה. עד אז מורידים את קובץ ההתקנה
מהגרסה ב־GitHub ובודקים אותו מול `SHA256SUMS`.

## עדכונים

- ‏Homebrew,‏ winget,‏ Flatpak ו־AUR מעדכנים את האפליקציה כמו כל חבילה אחרת.
- גם מנגנון העדכון של האפליקציה עצמה ([עדכוני אפליקציית שולחן העבודה](/he/getting-started/desktop-updates/))
  נשאר פעיל, ובודק את אותה גרסה חתומה.

## ארגז החול של Flatpak

אפליקציית ה־Flatpak יכולה להשתמש ברשת (סנכרון, הורדת מודלים, ובינה
מלאכותית בענן כשאתם מתירים) ובתיקיית `Documents`. כספת בכל תיקייה אחרת
נפתחת דרך בורר הקבצים של המערכת, שנותן גישה לתיקייה הזאת בלבד.

## למתחזקים

‏`node scripts/release.mjs packages` כותב את כל הקבצים ובודק אותם בלי
רשת. הפרטים ב־`RELEASE.md`, בסעיף "Stores and package managers".
