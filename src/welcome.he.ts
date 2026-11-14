/**
 * Hebrew welcome document — shown when the UI language is Hebrew (T45).
 * Keep sections in sync with ./welcome.ts.
 */
export const WELCOME_DOC_HE = `---
title: ברוכים הבאים ל-Lumen
author: אתם
date: 2026-04-25
tags: [markdown, demo]
---

# ברוכים הבאים ל-**Lumen** ✨

עורך Markdown שהופך *טקסט ונתונים* למסמכים יפים וחיים.
אפשר לעבור בין מצבי **Source**, **Split**, **Preview** ו-**WYSIWYG** מסרגל
הכלים שלמעלה (או בלחיצה על \`⌘1\`, \`⌘2\`, \`⌘3\`, \`⌘4\`). לחיצה על \`⌘K\` פותחת את
**לוח הפקודות** להוספת תרשימים, דיאגרמות, מפות, בלוקי מתמטיקה ועוד.
לחיצה על \`⇧⌘F\` מאפשרת חיפוש מקורב בכל הקבצים שבסביבת העבודה.

אפשר לגרור או להדביק תמונה ישירות לעורך — היא תישמר ב**סביבת העבודה**
שבדפדפן (OPFS) ותוכנס כקישור Markdown. מלוח הפקודות אפשר להציג או להסתיר
את סרגל הצד של סביבת העבודה ולראות עץ של כל הקבצים, ולהפעיל **סשן שיתופי**
בזמן אמת כדי לערוך יחד עם כל אחד דרך WebRTC.

> אפשר לגרור קובץ \`.md\`, \`.csv\`, \`.tsv\` או \`.json\` לכל מקום בחלון כדי לפתוח אותו.

---

## 1. טקסט עשיר, כמו שהוא צריך להיראות

התצוגה המקדימה משתמשת בגופן סריף מוקפד עם התאמה אופטית לגודל, ובמקביל
**מודגש**, *נטוי*, ~~קו חוצה~~, [קישורים](https://example.com) ו-\`inline code\`
שומרים כולם על קצב נקי ומכוון.

### רשימות ומעקב משימות

- רשימת תבליטים
- גם תבליטים מקוננים עובדים
  - בדיוק כך
  - וגם כך
- רשימות ממוספרות, הערות שוליים[^1], קיצורים ואימוג'י 🚀 — הכול מוצג באופן מובנה.

#### רשימת משימות

- [x] טיפוגרפיה יפהפייה
- [x] Markdown בסגנון GitHub
- [x] הדגשת קוד עם Shiki
- [x] מתמטיקה ב-LaTeX, ‏Mermaid, ‏ECharts, מפות
- [ ] יצירת המופת שלכם

[^1]: כן — הערות שוליים הן אזרחיות מן המניין.

---

## 2. קוד, עם הדגשה ברמת VS Code

בלוקי קוד מודגשים בעזרת **Shiki** (אותו מנוע שבו משתמש VS Code).

\`\`\`typescript title="parser.ts"
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export async function render(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .process(markdown);
  return String(file);
}
\`\`\`

\`\`\`python title="data.py"
import polars as pl

df = (
    pl.read_csv("sales.csv")
      .group_by("region")
      .agg(pl.col("revenue").sum().alias("total"))
      .sort("total", descending=True)
)
print(df)
\`\`\`

\`\`\`rust
fn main() {
    let primes: Vec<u32> = (2..50)
        .filter(|n| (2..*n).all(|i| n % i != 0))
        .collect();
    println!("{:?}", primes);
}
\`\`\`

---

## 3. מתמטיקה, כימיה ופיזיקה

מתמטיקה בתוך השורה: $E = mc^2$, יחס הזהב $\\varphi = \\tfrac{1+\\sqrt{5}}{2}$,
ונוסחת אוילר: $e^{i\\pi} + 1 = 0$.

מתמטיקה בתצוגה מלאה:

$$
\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}, \\qquad
\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0\\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}
$$

$$
\\hat{H}\\,\\psi = i\\hbar \\frac{\\partial \\psi}{\\partial t}
$$

כימיה באמצעות \\ce{}:

$$
\\ce{CO2 + 6H2O ->[\\text{light}] C6H12O6 + 6O2}
$$

---

## 4. דיאגרמות עם Mermaid

\`\`\`mermaid
flowchart LR
  A[📝 Markdown] -->|parse| B(remark)
  B --> C{Block type?}
  C -->|code| D[Shiki]
  C -->|math| E[KaTeX]
  C -->|chart| F[ECharts]
  C -->|csv / json| G[DataTable<br/>+ Auto chart]
  C -->|mermaid| H[Mermaid]
  C -->|map| I[Leaflet]
  D & E & F & G & H & I --> J((✨ Beautiful preview))
  style J fill:#7c5cff,stroke:#fff,color:#fff
\`\`\`

\`\`\`mermaid
sequenceDiagram
  autonumber
  participant U as You
  participant E as Editor
  participant P as Preview
  U->>E: types markdown
  E->>P: stream changes
  P->>P: parse + render
  P-->>U: live update ✨
\`\`\`

---

## 5. נתונים ← טבלאות ותרשימים, אוטומטית

מדביקים CSV גולמי — Lumen מנתח אותו, מזהה את סוגי העמודות, בונה טבלה הניתנת למיון
ו**מציע את התרשים המתאים באופן אוטומטי**. אפשר לעבור בין *טבלה* ל*תרשים*,
ואז לדפדף בין ההדמיות המוצעות.

\`\`\`csv title="Quarterly revenue by region"
quarter,region,revenue,deals
2024 Q1,Americas,4200,82
2024 Q1,EMEA,3100,61
2024 Q1,APAC,2700,49
2024 Q2,Americas,4800,90
2024 Q2,EMEA,3500,68
2024 Q2,APAC,3200,57
2024 Q3,Americas,5100,97
2024 Q3,EMEA,4000,75
2024 Q3,APAC,3700,66
2024 Q4,Americas,5800,108
2024 Q4,EMEA,4400,82
2024 Q4,APAC,4100,72
\`\`\`

מערכי JSON של אובייקטים עובדים באותה הדרך:

\`\`\`json-table title="Programming languages"
[
  { "lang": "TypeScript", "year": 2012, "stars": 102000, "paradigm": "multi" },
  { "lang": "Rust",       "year": 2010, "stars": 98000,  "paradigm": "systems" },
  { "lang": "Go",         "year": 2009, "stars": 124000, "paradigm": "systems" },
  { "lang": "Python",     "year": 1991, "stars": 230000, "paradigm": "multi" },
  { "lang": "Elixir",     "year": 2011, "stars": 24000,  "paradigm": "functional" },
  { "lang": "Zig",        "year": 2016, "stars": 36000,  "paradigm": "systems" },
  { "lang": "Gleam",      "year": 2016, "stars": 18000,  "paradigm": "functional" },
  { "lang": "Kotlin",     "year": 2011, "stars": 49000,  "paradigm": "multi" }
]
\`\`\`

אפשר גם לכתוב בלוק \`chart\` מפורש (מפרט ECharts ב-YAML או ב-JSON):

\`\`\`chart
title:
  text: Page-load budget vs measured
  textStyle: { color: '#9aa3b2' }
xAxis:
  type: category
  data: [Home, Docs, Pricing, Blog, Dashboard]
  axisLabel: { color: '#9aa3b2' }
yAxis:
  type: value
  axisLabel: { color: '#9aa3b2' }
legend:
  textStyle: { color: '#9aa3b2' }
  top: 24
series:
  - name: Budget
    type: bar
    barMaxWidth: 28
    itemStyle: { borderRadius: [4,4,0,0], color: '#475569' }
    data: [2.0, 2.5, 2.0, 2.5, 3.0]
  - name: Measured
    type: bar
    barMaxWidth: 28
    itemStyle: { borderRadius: [4,4,0,0], color: '#7c5cff' }
    data: [1.4, 2.1, 1.8, 2.7, 3.4]
tooltip:
  trigger: axis
\`\`\`

טבלאות בסגנון GitHub עדיין כאן כשצריך אותן:

| יכולת              | Lumen | Typora | Obsidian | StackEdit |
| ----------------- | :---: | :----: | :------: | :-------: |
| Mermaid           |   ✅   |   ❌    |    ✅     |     ✅     |
| KaTeX + mhchem    |   ✅   |   ✅    |    ✅     |     ✅     |
| ECharts           |   ✅   |   ❌    |    🔌    |     ❌     |
| CSV ← תרשים אוטומטי |   ✅   |   ❌    |    🔌    |     ❌     |
| מפות              |   ✅   |   ❌    |    🔌    |     ❌     |
| מקומי קודם כול     |   ✅   |   ✅    |    ✅     |     ⚠️    |

---

## 6. מפות (Leaflet)

\`\`\`map
center: [37.77, -25.0]
zoom: 2
markers:
  - { lat: 37.7749, lng: -122.4194, label: "San Francisco" }
  - { lat: 51.5074, lng: -0.1278,   label: "London" }
  - { lat: 35.6762, lng: 139.6503,  label: "Tokyo" }
  - { lat: -33.8688, lng: 151.2093, label: "Sydney" }
  - { lat: 40.7128, lng: -74.0060,  label: "New York" }
\`\`\`

---

## 7. תיבות הדגשה (Callouts)

:::note{title="לתשומת לבכם"}
הנחיות Markdown (\`:::note\`, \`:::tip\`, \`:::info\`, \`:::warning\`, \`:::danger\`)
הופכות לתיבות הדגשה מעוצבות.
:::

:::tip{title="טיפ למתקדמים"}
גוררים כל קובץ \`.csv\` או \`.json\` אל החלון — Lumen פותח אותו במסמך חדש
כשבלוק הנתונים כבר במקומו.
:::

:::warning{title="בלוק כבד"}
Mermaid, ‏Leaflet ו-ECharts נטענים *לפי דרישה* — כך החבילה הראשונית
נשארת קטנה.
:::

:::danger{title="שינויים שלא נשמרו"}
הנקודה הקטנה שליד שם הקובץ מסמנת שיש שינויים שלא נשמרו.
\`⌘S\` שומר; \`⇧⌘S\` שומר בשם.
:::

---

## 8. PlantUML, ‏Graphviz, מוזיקה ותלת־ממד — הכול מובנה

בלוק \`dot\` של Graphviz (מרונדר מקומית באמצעות WASM):

\`\`\`dot
digraph G {
  rankdir=LR;
  bgcolor="transparent";
  node [shape=box, style=rounded, color="#7c5cff", fontname="Inter"];
  edge [color="#9aa3b2"];
  Editor -> Pipeline -> Renderer;
  Pipeline -> "Block plugins" -> Renderer;
}
\`\`\`

כתב תווים באמצעות ABC:

\`\`\`abc
X:1
T:Lumen Theme
M:4/4
L:1/8
K:G
|:GABc dedB | dedB dedB | c2ec B2dB | A2EA B2EA |
GABc dedB | dedB dedB | c2ec B2dB |1 A2BG AGEG :|2 A2BG AGEG ||
\`\`\`

הטמעת YouTube באמצעות בלוק \`embed\` (תומך גם ב-Vimeo, ‏CodePen, ‏Figma,
‏Loom, ‏Spotify, ‏CodeSandbox ובכל כתובת URL):

\`\`\`embed
https://www.youtube.com/watch?v=dQw4w9WgXcQ
\`\`\`

**תצוגה חיה של HTML/CSS/JS** — מדביקים כל קטע קוד ו-Lumen מרנדר אותו בתוך
iframe מבודד (sandbox). אפשר לעבור ל-*Source* כדי לבחון את הקוד, או ל-*Fullscreen*
כדי שימלא את כל המסך:

\`\`\`htmlpreview height=280 title="Live demo"
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
  .card { padding: 1.75rem 2.5rem; border-radius: 16px;
          background: linear-gradient(135deg, #7c5cff, #22d3ee);
          box-shadow: 0 20px 50px -12px rgba(124,92,255,0.5); text-align: center; }
  h1 { margin: 0 0 0.5rem; font-size: 2rem; letter-spacing: -0.02em; }
  p  { margin: 0; opacity: 0.9; }
  button { margin-top: 1rem; padding: 0.4rem 1rem; border-radius: 999px;
           border: 0; background: rgba(255,255,255,0.2); color: inherit;
           cursor: pointer; backdrop-filter: blur(6px); }
</style>
<div class="card">
  <h1 id="t">Hello, Lumen ✨</h1>
  <p>Live HTML / CSS / JS, sandboxed and code-split.</p>
  <button onclick="document.getElementById('t').textContent = '🚀 Lift-off!';">
    Click me
  </button>
</div>
\`\`\`

---

## 9. קישורי ויקי

אפשר לשלב \`[[wiki-links]]\` בכל מקום. הם הופכים את היעד ל-slug וקופצים
לכותרת המתאימה — לדוגמה [[1. טקסט עשיר, כמו שהוא צריך להיראות|קפיצה לסעיף 1]].
כשסביבת העבודה פעילה (\`⌘K → Toggle workspace\`), הם עובדים גם בין קבצים.

---

## 10. ציטוט ונגיעה אחרונה

> *"הדרך הטובה ביותר לחזות את העתיד היא להמציא אותו."* — אלן קיי (Alan Kay)

---

## 11. המרות טבלאיות

Lumen הופך SQL, ‏Pandas, ‏JSON וליטרלים של אובייקטי JS לאותו ממשק של DataTable
הניתן למיון עם הצעות לתרשימים. שפת הבלוק קובעת באיזה מנתח להשתמש; השתמשו
ב-\`data\` לזיהוי אוטומטי.

גיבוי (dump) של SQL:

\`\`\`sql
CREATE TABLE sales (date TEXT, region TEXT, revenue REAL);
INSERT INTO sales (date, region, revenue) VALUES
  ('2026-01-01', 'North', 1240.50),
  ('2026-01-02', 'South',  980.00),
  ('2026-01-03', 'East',  1670.25),
  ('2026-01-04', 'West',  1120.75);
\`\`\`

הייצוג הטקסטואלי של DataFrame ב-Pandas:

\`\`\`pandas
    date        region   revenue
0   2026-01-01  North     1240.5
1   2026-01-02  South      980.0
2   2026-01-03  East      1670.25
3   2026-01-04  West      1120.75
\`\`\`

מערך אובייקטים בסגנון JS / JSON5 (מפתחות בלי מירכאות, מירכאות בודדות והערות —
הכול מתקבל בברכה):

\`\`\`object
[
  // Q1 launch metrics
  { product: 'Lumen Pro', signups: 1240, revenue: 18600 },
  { product: 'Lumen Team', signups:  480, revenue: 14400 },
  { product: 'Enterprise', signups:   38, revenue:  9500 },
]
\`\`\`

---

## 12. רשתות חברתיות

מכניסים כתובת URL ציבורית לבלוק \`embed\` ו-Lumen מרנדר את רכיב ההטמעה
של הפלטפורמה עצמה. למטה: פוסט מפורסם מכל פלטפורמה נתמכת —
הכתובות אמיתיות, ואפשר להעתיק אותן לכל מקום.

**וידאו ואודיו**

🎵 **YouTube** — ריק אסטלי, *"Never Gonna Give You Up"* (‏1.6 מיליארד צפיות, ה-rickroll)

\`\`\`embed
https://www.youtube.com/watch?v=dQw4w9WgXcQ
\`\`\`

🎬 **Vimeo** — *"Move"*, סרט המסע האייקוני של ריק מרקי: 44 ימים, 11 מדינות

\`\`\`embed
https://vimeo.com/22439234
\`\`\`

🎙️ **Loom** — סיור המוצר של Loom עצמה

\`\`\`embed
https://www.loom.com/share/c43a642f815f4378b6f80a889bb73d8d
\`\`\`

🎶 **Spotify** — Queen, *"Bohemian Rhapsody"* (מהשירים של המאה ה-20 שהושמעו הכי הרבה בסטרימינג)

\`\`\`embed
https://open.spotify.com/track/3z8h0TU7ReDPLIbEnYhWZb
\`\`\`

🎧 **SoundCloud** — Forss, *"Flickermood"* (‏10 מיליון השמעות)

\`\`\`embed
https://soundcloud.com/forss/flickermood
\`\`\`

**קוד ועיצוב**

🖌️ **CodePen** — הדגמת ה-shader האינטראקטיבית של חכים אל-חטאב

\`\`\`embed
https://codepen.io/hakimel/pen/BKyJpM
\`\`\`

🧪 **CodeSandbox** — sandbox חדש להתחלה מהירה עם React

\`\`\`embed
https://codesandbox.io/s/new
\`\`\`

🎨 **Figma Community** — ערכת ה-UI הרשמית של iOS 18

\`\`\`embed
https://www.figma.com/community/file/1394965242715869180
\`\`\`

🐙 **GitHub Gist** — ה-gist לדוגמה של Octocat (מוצג עם הדגשת תחביר)

\`\`\`embed
https://gist.github.com/octocat/6cad326836d38bd3a7ae
\`\`\`

**מפות**

🗼 **Google Maps** — מגדל אייפל, פריז

\`\`\`embed
https://www.google.com/maps/place/Eiffel+Tower
\`\`\`

📍 **OpenStreetMap** — טיימס סקוור, ניו יורק (חלופה ששומרת על פרטיות)

\`\`\`embed
https://www.openstreetmap.org/#map=18/40.7580/-73.9855
\`\`\`

**שיחות**

🐦 **X / Twitter** — אילון מאסק, *"the bird is freed"* (‏28 באוקטובר 2022, ההשתלטות על טוויטר)

\`\`\`embed
https://twitter.com/elonmusk/status/1585841080431321088
\`\`\`

🐣 **X / Twitter** — הציוץ הראשון אי־פעם של ג'ק דורסי, *"just setting up my twttr"* (‏21 במרץ 2006)

\`\`\`embed
https://twitter.com/jack/status/20
\`\`\`

📘 **Facebook** — פוסט אבן דרך של NASA

\`\`\`embed
https://www.facebook.com/NASA/posts/10168891891030772
\`\`\`

📷 **Instagram** — \`@world_record_egg\` (הביצה ששברה את שיא הלייקים של Instagram)

\`\`\`embed
https://www.instagram.com/p/BsOGulcndj-/
\`\`\`

🎵 **TikTok** — בלה פוארץ', *"M to the B"* (הסרטון עם הכי הרבה לייקים ב-TikTok אי־פעם, יותר מ-65 מיליון)

\`\`\`embed
https://www.tiktok.com/@bellapoarch/video/6862153058223197445
\`\`\`

👽 **Reddit** — ה-IAmA המפורסם של ביל גייטס, *"I am Bill Gates, co-chair of the Bill & Melinda Gates Foundation"*

\`\`\`embed
https://www.reddit.com/r/IAmA/comments/6byns4/i_am_bill_gates_cochair_of_the_bill_melinda_gates/
\`\`\`

💼 **LinkedIn** — ריד הופמן על עתיד העבודה

\`\`\`embed
https://www.linkedin.com/posts/reidhoffman_the-future-of-work-activity-7050231856721895424-Cf2T
\`\`\`

> **טיפ** — הדביקו כל אחת מהכתובות האלה בשורה ריקה בחלונית המקור
> ו-Lumen יציע כפתור "wrap as embed" בלחיצה אחת. נסו את זה.

כתיבה מהנה. ✦
`;
