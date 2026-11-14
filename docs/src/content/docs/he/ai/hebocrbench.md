---
title: מדד OCR חיצוני (HebOCRBench)
description: איך ה-OCR של Lumen נמדד ב-HebOCRBench, מדד עברי חיצוני שרק המארגנים שלו מחזיקים בתשובות, ואיפה הציונים מתפרסמים.
---

מספרי ה-OCR שלנו (הסט `ocr-he`, משימה 7.5) באים מסט שבנינו בעצמנו.
[HebOCRBench](https://huggingface.co/datasets/ssdataanalysis/hebocrbench-v1)
הוא מדד עברי חיצוני. המארגנים שומרים אצלם את תשובות הזהב, ולכן ציון שם לא
יכול לבוא ממבחן שבחרנו.

## חמשת המסלולים

| מסלול | תמונות |
| --- | --- |
| bidi (עברית מעורבת בטקסט לטיני ובמספרים) | 192 |
| שורות | 28,414 |
| עמודים | 700 |
| טבלאות | 61 |
| עמידות (טשטוש, רעש, הטיה) | 4,900 |

## הרצת הגשה

חבילת הקלט נשארת מחוץ לריפו, ב-Sandbox או במארח השני. התוכנה ברישיון MIT,
אבל כל תמונה שומרת את התנאים של המקור שלה.

```sh
node scripts/ocr/hebocrbench.mjs predict /data/hebocrbench /data/hob-out
node scripts/ocr/hebocrbench.mjs check-clean /data/hebocrbench
```

‏`predict` מריץ על כל תמונה את מסלול ה-OCR של האפליקציה עצמה
(`recognizeWithMixedFix` עם המודלים `heb` ו-`eng` שבריפו). הוא כותב
`predictions/<track>.jsonl` ו-`submission.json`, שבו רשומים הגרסה, ה-commit
וה-hash של המודלים. התחזיות בסדר לוגי וב-NFC, בלי סימני כיוון.
‏`check-clean` נכשל אם תמונה כלשהי מהחבילה נמצאת בריפו או ב-`dist`.

## פרסום הציון

כשהמארגנים מחזירים ציון לכל מסלול, מריצים:

```sh
node scripts/ocr/hebocrbench.mjs record scores.json --internal internal.json
```

הפקודה מוסיפה את הרשומה, עם התאריך והגרסה, ל-`eval/external/hebocrbench.json`.
אם ה-CER הפנימי שלנו וה-CER החיצוני רחוקים זה מזה ביותר מ-5 נקודות במסלול
כלשהו, הפקודה יוצאת עם קוד 3 ונפתחת משימת תיקון.

## מסלול ה-bidi כבדיקת רגרסיה

‏`hebocrbench.mjs bidi <before> <after>` משווה שתי הרצות של מסלול ה-bidi.
סימן כיוון חדש (W5.4) או מילה עברית שהתהפכה (W5.5) מכשילים אותו.

## ציונים

עדיין אין. ההגשה הראשונה היא פעולת בעלים.
