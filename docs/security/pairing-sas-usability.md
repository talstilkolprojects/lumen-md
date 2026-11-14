# Usability script: comparing the pairing symbols (plan W8.5)

**For:** Tal, with 5 participants. **Time:** about 15 minutes each.
**Acceptance (plan W8.5):** all 5 participants compare correctly, each in
under 20 seconds.

## Setup

- Two devices with the build of the pairing-symbols PR: a phone and a
  laptop. Sign both into the same encrypted test vault (a throwaway
  passphrase; never a real vault).
- Language: Hebrew on both devices for participants 1–3; Hebrew on one and
  English on the other for participants 4–5 (the emoji are the same in every
  language; this checks that people compare the pictures).
- A stopwatch, or a screen recording on both devices.
- For trial C, one screenshot of the laptop's comparison screen in which the
  **third** symbol was replaced by another one from the list (prepare it
  before the session from a real pairing; edit only that symbol).

Don't explain what the symbols are for before trial A. Read the tasks out
loud word for word.

## Trials

**A. First pairing (match).** "Pair the laptop with the phone. The laptop
shows a request; follow what the screens ask." Start the stopwatch when
both devices show the symbols; stop it when the participant has pressed
*They match* on the second device.
Record: the time, whether they looked at both screens, whether they compared
all five symbols, any hesitation or question.

**B. Second pairing (match), a minute later.** The same task, to see the time
once the screen is familiar.

**C. A mismatch.** Start a pairing as in A, then hold the prepared screenshot
next to the phone instead of the laptop. "Here is the laptop's screen. What
do you do?" Correct: *They don't match* on the phone.
Record: the answer, the time, whether they noticed which symbol differs.

**D. Nothing on the other device.** Start a pairing, then cancel it on the
phone (*Cancel pairing*), and ask the participant to finish on the laptop.
Correct: they don't press *They match* on the laptop, or, if they do, they
read that it is waiting and stop. Record what they did and said.

Note for the facilitator: on the phone (the device already in use), choosing
*They match* without looking at the laptop can still end in "Paired" there
even under an attack, but nothing is committed on the phone, and the real
laptop then stops. What protects the user is looking at both screens.

## After the trials (one question each, 1–5)

1. "How sure were you that the symbols matched?"
2. "How easy was it to compare them?"
3. "Was it clear what to do when they didn't match?"

## Record

| # | Languages | A: time / correct | B: time / correct | C: correct / time | D: what they did | Q1 | Q2 | Q3 | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | he / he | | | | | | | | |
| 2 | he / he | | | | | | | | |
| 3 | he / he | | | | | | | | |
| 4 | he / en | | | | | | | | |
| 5 | he / en | | | | | | | | |

**Pass:** A and B correct for all 5, each under 20 s; C correct for all 5.
If any symbol was misread, write which one (index and name) in Notes: that
symbol's name or emoji should be changed in the list (src/sync/e2ee/sas.ts
and the `e2ee.sas.w<index>` keys), and the test vectors stay valid (they
record indices).

---

# תסריט בדיקת שמישות: השוואת סמלי הצימוד (משימה W8.5)

**למי:** טל, עם 5 משתתפים. **זמן:** כ-15 דקות לכל אחד.
**קבלה (משימה W8.5):** כל 5 המשתתפים משווים נכון, כל אחד בפחות מ-20 שניות.

## הכנה

- שני מכשירים עם הבנייה של ה-PR של סמלי הצימוד: טלפון ומחשב נייד. חברו את
  שניהם לאותה כספת בדיקה מוצפנת (סיסמה זמנית; אף פעם לא כספת אמיתית).
- שפה: עברית בשני המכשירים למשתתפים 1–3; עברית באחד ואנגלית בשני למשתתפים
  4–5 (האימוג׳י זהים בכל השפות; זה בודק שאנשים משווים את התמונות).
- סטופר, או הקלטת מסך בשני המכשירים.
- לניסוי ג׳, צילום מסך אחד של מסך ההשוואה במחשב הנייד שבו הסמל **השלישי**
  הוחלף בסמל אחר מהרשימה (הכינו אותו לפני המפגש מצימוד אמיתי; שנו רק את הסמל
  הזה).

אל תסבירו למה הסמלים משמשים לפני ניסוי א׳. הקריאו את המשימות מילה במילה.

## ניסויים

**א. צימוד ראשון (זהים).** "צמדו את המחשב הנייד לטלפון. המחשב מציג בקשה;
עשו מה שהמסכים מבקשים." הפעילו את הסטופר כששני המכשירים מציגים את הסמלים;
עצרו אותו כשהמשתתף לחץ *זהים* במכשיר השני.
רשמו: הזמן, האם הסתכל בשני המסכים, האם השווה את כל חמשת הסמלים, היסוס או
שאלה.

**ב. צימוד שני (זהים), דקה אחר כך.** אותה משימה, כדי לראות את הזמן כשהמסך
כבר מוכר.

**ג. אי־התאמה.** התחילו צימוד כמו בא׳, ואז החזיקו את צילום המסך שהוכן ליד
הטלפון במקום המחשב. "זה המסך של המחשב הנייד. מה אתם עושים?" נכון: *לא זהים*
בטלפון.
רשמו: התשובה, הזמן, האם הבחין איזה סמל שונה.

**ד. אין כלום במכשיר השני.** התחילו צימוד, בטלו אותו בטלפון (*ביטול צימוד*),
ובקשו מהמשתתף לסיים במחשב הנייד. נכון: לא לוחץ *זהים* במחשב, או, אם לחץ,
קורא שהוא ממתין ועוצר. רשמו מה עשה ואמר.

הערה למנחה: בטלפון (המכשיר שכבר בשימוש), בחירה ב*זהים* בלי להסתכל במחשב יכולה
להסתיים ב"מצומד" שם גם תחת התקפה, אבל שום דבר לא נרשם בטלפון, והמחשב האמיתי
עוצר. מה שמגן על המשתמש הוא להסתכל בשני המסכים.

## אחרי הניסויים (שאלה אחת כל אחת, 1–5)

1. "עד כמה הייתם בטוחים שהסמלים זהים?"
2. "עד כמה היה קל להשוות אותם?"
3. "האם היה ברור מה לעשות כשהם לא היו זהים?"

## רישום

| # | שפות | א: זמן / נכון | ב: זמן / נכון | ג: נכון / זמן | ד: מה עשה | ש1 | ש2 | ש3 | הערות |
|---|---|---|---|---|---|---|---|---|---|
| 1 | he / he | | | | | | | | |
| 2 | he / he | | | | | | | | |
| 3 | he / he | | | | | | | | |
| 4 | he / en | | | | | | | | |
| 5 | he / en | | | | | | | | |

**עובר:** א׳ וב׳ נכונים לכל ה-5, כל אחד מתחת ל-20 שניות; ג׳ נכון לכל ה-5.
אם סמל כלשהו נקרא לא נכון, רשמו איזה (מספר ושם) בהערות: צריך להחליף את השם או
האימוג׳י שלו ברשימה (src/sync/e2ee/sas.ts ומפתחות `e2ee.sas.w<index>`), ווקטורי
הבדיקה נשארים תקפים (הם רושמים מספרים).
