---
title: ציטוטים (BibTeX)
description: בלוק ```bibtex הופך לרשימת מקורות ב-APA 7, ‏Chicago (מחבר-תאריך) או MLA 9 — באנגלית או בעברית, בלי לשלוח דבר.
---

מדביקים BibTeX בבלוק ` ```bibtex ` (או ` ```bib `) ו-Lumen מציג רשימת
מקורות. את הסגנון בוחרים בכותרת הבלוק; הרשימה ממוינת לפי מחבר ושנה, עם
הזחה תלויה. ריחוף מעל מקור מציג את ההפניה בגוף הטקסט.

````markdown
```bibtex
% style: chicago
% lang: he
@article{watson1953molecular,
  author = {Watson, James D. and Crick, Francis H. C.},
  title = {Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid},
  journal = {Nature}, volume = {171}, number = {4356}, pages = {737--738},
  year = {1953}, doi = {10.1038/171737a0}
}
```
````

## סגנונות

| סגנון | מקור | בגוף הטקסט |
| --- | --- | --- |
| APA 7 (ברירת מחדל) | Watson, J. D., ו-Crick, F. H. C. (1953). Molecular structure of nucleic acids: A structure for deoxyribose nucleic acid. *Nature*, *171*(4356), 737–738. https://doi.org/10.1038/171737a0 | (Watson ו-Crick, 1953) |
| Chicago מחבר-תאריך (מהדורה 18) | Watson, James D., ו-Francis H. C. Crick. 1953. “Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid.” *Nature* 171 (4356): 737–38. https://doi.org/10.1038/171737a0. | (Watson ו-Crick 1953) |
| MLA 9 | Watson, James D., ו-Francis H. C. Crick. “Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid.” *Nature*, כרך 171, גיליון 4356, 1953, עמ׳ 737–38, https://doi.org/10.1038/171737a0. | (Watson ו-Crick) |

- **APA** הופך את הכותרת לאות גדולה רק בתחילת משפט. מילים בסוגריים
  מסולסלים שומרות על האותיות שלהן (`{DNA}`, `{Wonderland}`), וכך גם ראשי
  תיבות והמילה הראשונה אחרי נקודתיים. כותרת בגרמנית (`langid = {german}`)
  נשארת כמו שהיא.
- **Chicago** ו-**MLA** שומרים את הכותרת כפי שנכתבה ומקצרים טווחי עמודים
  לפי הכללים שלהם (737–38). MLA משמיט *Company* / *Co.* משמות הוצאות וכותב
  *University Press* כ-*UP*.

## עברית

`% lang: he` (או עברית כשפת הממשק) משנה את המילים, לא את הסדר: *and* /
*&* ← ו (ו- לפני שם לטיני), *et al.* ← ואחרים, ובסגנון MLA ‏*vol.* / *no.*
/ *pp.* ← כרך / גיליון / עמ׳. שמות, כותרות והוצאות נשארים כפי שפורסמו.
כל מקור שומר על הכיוון שלו.

## בלי רשת

העיצוב הוא כללים של Lumen עצמו (בלי citeproc, בלי קובצי CSL, בלי
הורדה). השאלה אם מותר להשתמש ב-citeproc היא החלטת רישוי פתוחה (תוכנית
15.10); הכללים כאן הם החלופה שהתוכנית מציינת. חיפוש DOI אינו חלק מהבלוק —
הוא נשאר בלי רשת.
