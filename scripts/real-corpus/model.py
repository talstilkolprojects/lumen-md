"""Plan W6.38: 30 source documents (written for this corpus, CC0 1.0), seeded.
Each is a block model; renderers turn it into HTML for LibreOffice, a Google
Docs clipboard payload and a Word clipboard payload."""
import random, json, sys

TOPICS = [
 ("סיכום ישיבת צוות", "Team meeting notes"), ("תוכנית לימודים: מבוא לסטטיסטיקה", "Syllabus: intro to statistics"),
 ("מתכון: שקשוקה ירוקה", "Recipe: green shakshuka"), ("הצעת מחיר לשיפוץ מטבח", "Quote: kitchen renovation"),
 ("קורות חיים: מפתחת תוכנה", "CV: software developer"), ("מדריך התקנה למדפסת", "Printer setup guide"),
 ("פרוטוקול ועד הבית", "Building committee minutes"), ("תכנון טיול לגליל", "Trip plan: the Galilee"),
 ("סקירת ספר: מאה שנים של בדידות", "Book review"), ("מסמך דרישות: אפליקציית תורים", "Requirements: booking app"),
 ("הנחיות לעבודה סמינריונית", "Seminar paper guidelines"), ("דוח רבעוני: מכירות", "Quarterly sales report"),
 ("נוהל עבודה בטוחה במעבדה", "Lab safety procedure"), ("רשימת ציוד לקייטנה", "Summer camp packing list"),
 ("מכתב המלצה", "Recommendation letter"), ("סיכום הרצאה: תורת הקבוצות", "Lecture notes: set theory"),
 ("תקנון מועדון הקריאה", "Reading club bylaws"), ("תוכנית אימונים לחצי מרתון", "Half-marathon training plan"),
 ("מדיניות פרטיות לאתר קטן", "Privacy policy for a small site"), ("מערך שיעור: שברים", "Lesson plan: fractions"),
 ("הוראות שימוש במכונת כביסה", "Washing machine manual"), ("השוואת ספקי אינטרנט", "ISP comparison"),
 ("תיאור משרה: מנהל/ת מוצר", "Job description: product manager"), ("יומן פרויקט: גינה קהילתית", "Project log: community garden"),
 ("סיכום פגישה עם לקוח", "Client meeting summary"), ("מדריך כתיבת README", "How to write a README"),
 ("תוכנית חירום משפחתית", "Family emergency plan"), ("בקשה למלגה", "Scholarship application"),
 ("השוואת מסגרות JavaScript", "JavaScript frameworks compared"), ("תפריט שבועי לבית", "Weekly home menu"),
]
SENT = [
 "הפגישה התקיימה ביום שלישי בשעה 10:00 במשרד בתל אביב.", "המטרה היא לסיים את השלב הראשון עד סוף החודש.",
 "יש לבדוק את הנתונים מול הדוח של Q3 לפני ההגשה.", "כל המשתתפים קיבלו עותק של המסמך מראש.",
 "העלות המשוערת היא 12,500 ש\"ח כולל מע\"מ.", "אפשר להשתמש ב-Excel או ב-Google Sheets לחישוב.",
 "הטמפרטורה בתנור צריכה להיות 180 מעלות.", "שימו לב: הגרסה החדשה (2.4.1) דורשת Node 22 ומעלה.",
 "בפרק השני נדון בהתפלגות נורמלית ובסטיית תקן.", "ההרשמה נפתחת ב-1 בספטמבר ונסגרת ב-15 בו.",
 "המסלול אורך כ-14 ק\"מ ומתאים למשפחות עם ילדים.", "לשאלות אפשר לפנות אל רכזת הפרויקט בטלפון 03-5551234.",
 "הספר מתאר שבעה דורות של משפחה אחת בכפר בדיוני.", "המערכת תתמוך בעברית, באנגלית ובערבית מהיום הראשון.",
 "חשוב לשמור על גיבוי יומי של כל הקבצים.", "בסוף כל שבוע נשלח סיכום קצר לכל הצוות.",
 "הנתונים נאספו בין ינואר למרץ 2026.", "ההחלטה התקבלה פה אחד, למעט נמנע אחד.",
 "Please send the signed form by Thursday.", "The API returns JSON with a status field.",
]
ITEMS = [
 "לבדוק את התקציב", "לעדכן את לוח הזמנים", "להזמין חומרים", "לשלוח הזמנות למשתתפים", "לתאם פגישה עם הספק",
 "לכתוב טיוטה ראשונה", "לקרוא את פרק 3", "להכין מצגת של 10 שקפים", "בצל אחד קצוץ", "שתי כפות שמן זית",
 "200 גרם תרד", "4 ביצים", "מטען לטלפון", "בקבוק מים", "כובע ומשקפי שמש", "לבדוק תאימות ל-iOS 18",
 "להריץ את הבדיקות (npm test)", "לסגור את הדוח הכספי", "Review the pull request", "Update the README",
]
TABLES = [
 [["שם", "תפקיד", "טלפון"], ["דנה כהן", "מנהלת", "050-1234567"], ["יוסי לוי", "מפתח", "052-7654321"], ["Sara Smith", "QA", "054-1112233"]],
 [["רבעון", "הכנסות", "שינוי"], ["Q1", "120,000", "+4%"], ["Q2", "135,500", "+13%"], ["Q3", "128,900", "-5%"]],
 [["יום", "ארוחת בוקר", "ארוחת ערב"], ["ראשון", "חביתה", "מרק עדשים"], ["שני", "יוגורט", "פסטה ברוטב עגבניות"]],
 [["ספק", "מהירות", "מחיר חודשי"], ["ספק א", "1000Mb", "₪99"], ["ספק ב", "500Mb", "₪79"]],
 [["שבוע", "ריצה ארוכה", "אימון מהירות"], ["1", "8 ק\"מ", "6×400 מ'"], ["2", "10 ק\"מ", "5×800 מ'"], ["3", "12 ק\"מ", "4×1 ק\"מ"]],
]
LINKS = [("אתר העירייה", "https://example.com/city"), ("המדריך המלא", "https://example.org/guide"),
 ("טופס ההרשמה", "https://example.com/register?lang=he"), ("the docs", "https://example.net/docs/start"),
 ("ויקיפדיה", "https://example.org/wiki/%D7%A9%D7%9C%D7%95%D7%9D")]
H2 = ["רקע", "מטרות", "פרטים", "משימות להמשך", "לוח זמנים", "סיכום", "שאלות פתוחות", "הערות", "מרכיבים", "שלבים"]
H3 = ["הערה טכנית", "דגשים", "חלופות", "סיכונים"]

def para(r):
  runs = []
  for k in range(r.randint(1, 3)):
    s = r.choice(SENT)
    style = r.random()
    if style < 0.15: runs.append({"text": s, "bold": True})
    elif style < 0.25: runs.append({"text": s, "italic": True})
    else: runs.append({"text": s})
    runs.append({"text": " "})
  if r.random() < 0.6:
    t, u = r.choice(LINKS)
    runs.append({"text": "ראו גם "}); runs.append({"text": t, "href": u}); runs.append({"text": "."})
  else:
    runs.pop()
  return {"t": "p", "runs": runs}

def build(i):
  r = random.Random(1000 + i)
  he, en = TOPICS[i]
  english = i in (25, 28)  # two English-led documents with Hebrew inside
  blocks = [{"t": "h", "level": 1, "text": en if english else he}]
  blocks.append(para(r))
  for s in r.sample(H2, r.randint(2, 3)):
    blocks.append({"t": "h", "level": 2, "text": s})
    blocks.append(para(r))
    kind = r.random()
    if kind < 0.45:
      items = []
      for it in r.sample(ITEMS, r.randint(2, 4)):
        node = {"text": it}
        if r.random() < 0.35: node["children"] = [{"text": c} for c in r.sample(ITEMS, 2)]
        items.append(node)
      blocks.append({"t": "ol" if r.random() < 0.4 else "ul", "items": items})
    elif kind < 0.7:
      blocks.append({"t": "table", "rows": r.choice(TABLES)})
    if r.random() < 0.3:
      blocks.append({"t": "h", "level": 3, "text": r.choice(H3)}); blocks.append(para(r))
  if i % 3 == 0:
    blocks.append({"t": "img", "src": f"img{i % 5}.png", "alt": f"תרשים {i}"})
  # every document has at least one list, table and link somewhere
  if not any(b["t"] in ("ul", "ol") for b in blocks): blocks.append({"t": "ul", "items": [{"text": x} for x in r.sample(ITEMS, 3)]})
  if not any(b["t"] == "table" for b in blocks) and i % 2 == 0: blocks.append({"t": "table", "rows": r.choice(TABLES)})
  if not any(x.get("href") for b in blocks if b["t"] == "p" for x in b["runs"]):
    t, u = LINKS[i % len(LINKS)]; blocks.append({"t": "p", "runs": [{"text": "קישור: "}, {"text": t, "href": u}]})
  return {"id": f"doc{i+1:02d}", "dir": "ltr" if english else "rtl", "blocks": blocks}

if __name__ == "__main__":
  json.dump([build(i) for i in range(30)], open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
