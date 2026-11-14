/**
 * Plan W2.18 — the 20 golden Mermaid diagrams (4 of each editable type),
 * most with Hebrew labels. `nodes` / `edges` are how many labels each must
 * show once converted (checked by expectedLabels in the unit test, and
 * against the converted elements in e2e/canvas-mermaid.spec.ts).
 */
export interface GoldenDiagram {
  id: string;
  code: string;
  nodes: number;
  edges: number;
}

export const MERMAID_GOLDEN: GoldenDiagram[] = [
  { id: "flow-he-simple", nodes: 3, edges: 0, code: "flowchart TD\n  A[התחלה] --> B[עיבוד]\n  B --> C[סוף]" },
  { id: "flow-he-decision", nodes: 4, edges: 2, code: 'flowchart LR\n  A["בקשה חדשה"] --> B{"האם מאושר?"}\n  B -->|כן| C(["שליחה ללקוח"])\n  B -->|לא| D[("ארכיון")]' },
  { id: "flow-mixed-subgraph", nodes: 5, edges: 1, code: "flowchart TB\n  subgraph s1 [שלב ראשון]\n    A[Draft טיוטה] --> B[Review]\n  end\n  B -- אושר --> C((Publish))\n  C --> D>הודעה למנויים]" },
  { id: "flow-en", nodes: 4, edges: 1, code: "graph TD\n  Start --> Check{Valid?}\n  Check -->|yes| Save[(Database)]\n  Check --> Retry" },
  { id: "seq-he", nodes: 2, edges: 2, code: "sequenceDiagram\n  participant U as משתמש\n  participant S as שרת\n  U->>S: בקשת התחברות\n  S-->>U: אסימון" },
  { id: "seq-he-note", nodes: 4, edges: 3, code: "sequenceDiagram\n  actor A as אליס\n  participant B as בוב\n  participant C as קרול\n  A->>B: שלום בוב\n  B->>C: העבר לקרול\n  Note over B,C: בדיקה פנימית\n  C-->>A: תשובה" },
  { id: "seq-en", nodes: 3, edges: 3, code: "sequenceDiagram\n  Browser->>API: GET /notes\n  API->>DB: query\n  DB-->>API: rows" },
  { id: "seq-mixed", nodes: 2, edges: 2, code: "sequenceDiagram\n  participant App\n  participant Ollama as מודל מקומי\n  App->>Ollama: prompt בעברית\n  Ollama-->>App: Mermaid" },
  { id: "class-he", nodes: 3, edges: 2, code: 'classDiagram\n  class Note["פתק"]\n  class Tag["תגית"]\n  class Vault["כספת"]\n  Vault "1" --> "*" Note : מכילה\n  Note --> Tag : מתויג' },
  { id: "class-members", nodes: 2, edges: 0, code: "classDiagram\n  class Animal {\n    +String name\n    +speak() void\n  }\n  class Dog\n  Animal <|-- Dog" },
  { id: "class-en", nodes: 4, edges: 1, code: "classDiagram\n  Canvas *-- Element\n  Element <|-- Card\n  Card ..> Note : shows" },
  { id: "class-mixed", nodes: 2, edges: 1, code: 'classDiagram\n  class Reader["קורא EPUB"]\n  class Highlight\n  Reader --> Highlight : creates הדגשות' },
  { id: "state-he", nodes: 3, edges: 2, code: 'stateDiagram-v2\n  state "טיוטה" as Draft\n  state "בבדיקה" as Review\n  state "פורסם" as Published\n  [*] --> Draft\n  Draft --> Review : שליחה\n  Review --> Published : אישור\n  Published --> [*]' },
  { id: "state-en", nodes: 3, edges: 1, code: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Recording : start\n  Recording --> Idle\n  Recording --> Saved\n  Saved --> [*]" },
  { id: "state-desc", nodes: 2, edges: 0, code: "stateDiagram-v2\n  Online : מחובר לרשת\n  Offline : עובד בלי רשת\n  Online --> Offline\n  Offline --> Online" },
  { id: "state-mixed", nodes: 3, edges: 2, code: 'stateDiagram-v2\n  state "ממתין" as Waiting\n  [*] --> Waiting\n  Waiting --> Running : run ריצה\n  Running --> Done : סיום\n  Done --> [*]' },
  { id: "er-he", nodes: 2, edges: 1, code: 'erDiagram\n  CUSTOMER["לקוח"] {\n    string name\n  }\n  ORDER["הזמנה"] {\n    int id\n  }\n  CUSTOMER ||--o{ ORDER : "מבצע"' },
  { id: "er-attrs", nodes: 2, edges: 1, code: "erDiagram\n  BOOK ||--|{ HIGHLIGHT : has\n  BOOK {\n    string title\n    string author\n  }\n  HIGHLIGHT {\n    string text\n  }" },
  { id: "er-three", nodes: 3, edges: 2, code: 'erDiagram\n  AUTHOR["מחבר"] {\n    string name\n  }\n  BOOK["ספר"] {\n    string title\n  }\n  REVIEW["ביקורת"] {\n    int stars\n  }\n  AUTHOR ||--o{ BOOK : "כותב"\n  BOOK ||--o{ REVIEW : "מקבל"' },
  { id: "er-en", nodes: 2, edges: 1, code: "erDiagram\n  NOTE }o--o{ TAG : labelled" },
];
