/**
 * Agent eval fixtures (MASTER_PLAN v2, E1) — mostly Hebrew, because Hebrew
 * is what the local models are most likely to get wrong and what the
 * product's first user writes in.
 *
 * Each case names an agent, its input, deterministic checks on the
 * output, and a reference `example` answer. The offline test runs every
 * example through the agent's own parser and validators and through the
 * checks, so a broken fixture fails in CI before anyone spends an hour of
 * GPU on it. The live run (`npm run eval:agents`) replaces the example
 * with the real model's answer.
 */

import type { AgentInput } from "../types";
import type { Check } from "./score";

export interface EvalCase {
  id: string;
  agent: string;
  input: AgentInput;
  checks: Check[];
  /** A good answer, as the model would return it (raw text). */
  example: string;
}

const MEETING_HE = `פגישת צוות — 12.10

נכחו: דנה, יואב, מיכל.

- דנה תשלח את הצעת המחיר ללקוח עד יום חמישי.
- יואב יבדוק את באג ההתחברות במובייל.
- הוחלט לדחות את ההשקה בשבוע.
- מיכל תתאם פגישה עם צוות העיצוב לשבוע הבא.`;

const ARTICLE_HE = `רשתות נוירונים הן מודלים חישוביים בהשראת המוח.
הן בנויות משכבות של יחידות שמחוברות זו לזו.

האימון נעשה בעזרת אלגוריתם הפצה לאחור.
המשקלות מתעדכנים כדי להקטין את השגיאה.

מודלי שפה גדולים הם רשתות עמוקות במיוחד.
הם מאומנים על כמויות עצומות של טקסט.

השימושים כוללים תרגום, סיכום ומענה על שאלות.
לצד היתרונות יש גם סיכונים של הטיה ושגיאות.`;

const PROCESS_HE = `תהליך הזמנה: הלקוח בוחר מוצר ומוסיף לעגלה. אחר כך הוא עובר לתשלום.
אם התשלום מאושר, המחסן אורז את ההזמנה ושולח אותה. אם התשלום נדחה, הלקוח מקבל הודעה ומתבקש לנסות שוב.`;

const SALES_CSV = `חודש,מכירות,הוצאות
ינואר,120,80
פברואר,135,90
מרץ,160,95
אפריל,150,100`;

export const EVAL_CASES: EvalCase[] = [
  {
    id: "tagger-he",
    agent: "tagger",
    input: { text: ARTICLE_HE, extra: { existing: ["למידת-מכונה", "בינה-מלאכותית", "בישול"] } },
    checks: [
      { type: "minItems", path: "tags", min: 2 },
      { type: "hebrew", min: 0.6 },
      { type: "notContains", none: ["בישול"] },
    ],
    example: '{"tags": ["למידת-מכונה", "בינה-מלאכותית", "רשתות-נוירונים"]}',
  },
  {
    id: "tagger-en",
    agent: "tagger",
    input: { text: "Kubernetes schedules containers across a cluster. A Deployment keeps replicas running; a Service exposes them.", extra: { existing: ["devops", "cooking"] } },
    checks: [
      { type: "minItems", path: "tags", min: 2 },
      { type: "containsAny", any: ["kubernetes", "devops", "containers"] },
      { type: "notContains", none: ["cooking"] },
    ],
    example: '{"tags": ["kubernetes", "devops", "containers"]}',
  },
  {
    id: "outliner-he",
    agent: "outliner",
    input: { text: ARTICLE_HE },
    checks: [{ type: "minItems", path: "headings", min: 2 }, { type: "hebrew", min: 0.6 }],
    example: '{"headings": [{"level": 2, "title": "מהן רשתות נוירונים", "line": 0}, {"level": 2, "title": "אימון", "line": 3}, {"level": 2, "title": "מודלי שפה", "line": 6}, {"level": 2, "title": "שימושים וסיכונים", "line": 9}]}',
  },
  {
    id: "tasker-he",
    agent: "tasker",
    input: { text: MEETING_HE },
    checks: [
      { type: "matches", source: "^\\s*[-*]\\s*\\[ \\]", flags: "m" },
      { type: "contains", all: ["דנה", "יואב", "מיכל"] },
      { type: "hebrew", min: 0.7 },
      { type: "notContains", none: ["לדחות את ההשקה"] },
    ],
    example: "- [ ] דנה: לשלוח את הצעת המחיר ללקוח (עד יום חמישי)\n- [ ] יואב: לבדוק את באג ההתחברות במובייל\n- [ ] מיכל: לתאם פגישה עם צוות העיצוב (שבוע הבא)",
  },
  {
    id: "translator-en-he",
    agent: "translator",
    input: {
      text: "# Getting started\n\nInstall the app and open a folder. See the [guide](https://example.com/guide).\n\n```bash\nnpm install\n```",
      extra: { targetLanguage: "Hebrew" },
    },
    checks: [{ type: "hebrew", min: 0.5 }, { type: "contains", all: ["https://example.com/guide", "npm install", "```"] }],
    example: "# תחילת עבודה\n\nהתקינו את האפליקציה ופתחו תיקייה. ראו את [המדריך](https://example.com/guide).\n\n```bash\nnpm install\n```",
  },
  {
    id: "translator-he-en",
    agent: "translator",
    input: { text: MEETING_HE, extra: { targetLanguage: "English" } },
    checks: [{ type: "maxHebrew", max: 0.02 }, { type: "containsAny", any: ["Dana", "Danna"] }, { type: "matches", source: "Thursday", flags: "i" }],
    example: "Team meeting — 12.10\n\nPresent: Dana, Yoav, Michal.\n\n- Dana will send the price quote to the client by Thursday.\n- Yoav will check the mobile login bug.\n- It was decided to postpone the launch by a week.\n- Michal will set up a meeting with the design team next week.",
  },
  {
    id: "proofreader-he",
    agent: "proofreader",
    input: { text: "אני הולכת לחנות מחר בבוקר וקניתי לחם. הילדים משחקים בגינה כל היום", extra: { language: "Hebrew" } },
    checks: [{ type: "minItems", path: "issues", min: 1 }],
    example: '{"issues": [{"quote": "וקניתי", "message": "זמן הפועל לא מתאים ל\\"מחר\\"", "replacement": "ואקנה"}]}',
  },
  {
    id: "diagrammer-he",
    agent: "diagrammer",
    input: { text: PROCESS_HE },
    checks: [{ type: "matches", source: "^(flowchart|graph)\\s", flags: "m" }, { type: "containsAny", any: ["תשלום"] }],
    example: "flowchart TD\n  A[הלקוח בוחר מוצר] --> B[הוספה לעגלה]\n  B --> C[תשלום]\n  C -->|מאושר| D[המחסן אורז ושולח]\n  C -->|נדחה| E[הודעה ללקוח]\n  E --> C",
  },
  {
    id: "charter-he",
    agent: "charter",
    input: { text: SALES_CSV },
    checks: [{ type: "minItems", path: "series", min: 1 }, { type: "contains", all: ["ינואר", "אפריל"] }],
    example: '{"title": {"text": "מכירות והוצאות"}, "xAxis": {"type": "category", "data": ["ינואר", "פברואר", "מרץ", "אפריל"]}, "yAxis": {"type": "value"}, "series": [{"name": "מכירות", "type": "bar", "data": [120, 135, 160, 150]}, {"name": "הוצאות", "type": "bar", "data": [80, 90, 95, 100]}]}',
  },
  {
    id: "committer",
    agent: "committer",
    input: { text: "MODIFIED: src/agents/runtime.ts\nADDED: src/agents/eval/score.ts\nADDED: src/agents/eval/fixtures.ts" },
    checks: [{ type: "maxChars", max: 72 }, { type: "matches", source: "^[a-z]+(\\([\\w./-]+\\))?!?: \\S" }],
    example: "feat(agents): add the agent eval harness",
  },
  {
    id: "writer-he",
    agent: "writer",
    input: { text: "המשך את הפסקה בשני משפטים, באותו סגנון:\n\nהבוקר בתל אביב היה שקט במיוחד. הרחובות עוד היו רטובים מהגשם של הלילה," },
    checks: [{ type: "hebrew", min: 0.8 }, { type: "maxChars", max: 1200 }],
    example: "והאוויר הריח מאדמה ומקפה מהבתים הסמוכים. אנשים יצאו לאט מהבניינים, כאילו אף אחד לא רצה להפר את השקט.",
  },
  {
    id: "linker-he",
    agent: "linker",
    input: {
      text: "היום למדתי על הפצה לאחור ועל איך רשתות נוירונים מתאמנות.",
      extra: { catalog: "- הפצה לאחור — האלגוריתם שמעדכן את המשקלות ברשת.\n- מתכון לעוגה — עוגת שוקולד פשוטה.", titles: ["הפצה לאחור", "מתכון לעוגה"] },
    },
    checks: [{ type: "minItems", path: "links", min: 1 }, { type: "contains", all: ["הפצה לאחור"] }, { type: "notContains", none: ["מתכון לעוגה"] }],
    example: '{"links": [{"phrase": "הפצה לאחור", "target": "הפצה לאחור", "reason": "הפתק מגדיר את המונח"}]}',
  },
  {
    id: "formulator-he",
    agent: "formulator",
    input: {
      text: "כמה ימים נשארו עד תאריך היעד, ואם המשימה כבר הושלמה — כלום",
      extra: { fields: [{ name: "סטטוס", example: "הושלם" }, { name: "יעד", example: "2026-11-01" }, { name: "מחיר" }] },
    },
    checks: [{ type: "contains", all: ["יעד", "סטטוס"] }, { type: "containsAny", any: ["datediff", "today()"] }, { type: "maxChars", max: 200 }],
    example: 'if(סטטוס = "הושלם", null, datediff(יעד, today()))',
  },
];
