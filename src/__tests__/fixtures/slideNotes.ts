/**
 * Plan W2.17 — 10 golden notes and the slides each must give: per slide
 * its title, direction, whether it has speaker notes, and its first line
 * (the "snapshot" the acceptance names, kept readable).
 */
export interface GoldenNote {
  id: string;
  md: string;
  slides: Array<{ title: string; dir: "ltr" | "rtl"; notes: string; first: string }>;
}

export const SLIDE_GOLDEN: GoldenNote[] = [
  {
    id: "he-headings",
    md: "# תוכנית הרבעון\n\nשלוש מטרות.\n\n## מכירות\n\n- להגדיל ב־20%\n\n## גיוס\n\n- שני מפתחים",
    slides: [
      { title: "תוכנית הרבעון", dir: "rtl", notes: "", first: "# תוכנית הרבעון" },
      { title: "מכירות", dir: "rtl", notes: "", first: "## מכירות" },
      { title: "גיוס", dir: "rtl", notes: "", first: "## גיוס" },
    ],
  },
  {
    id: "en-rules",
    md: "Welcome\n\n---\n\nAgenda\n\n- one\n- two\n\n---\n\nThanks!",
    slides: [
      { title: "", dir: "ltr", notes: "", first: "Welcome" },
      { title: "", dir: "ltr", notes: "", first: "Agenda" },
      { title: "", dir: "ltr", notes: "", first: "Thanks!" },
    ],
  },
  {
    id: "mixed-both",
    md: "# כותרת\n\nפתיחה\n\n---\n\nעוד באותו נושא\n\n## Next topic\n\nEnglish text",
    slides: [
      { title: "כותרת", dir: "rtl", notes: "", first: "# כותרת" },
      { title: "", dir: "rtl", notes: "", first: "עוד באותו נושא" },
      { title: "Next topic", dir: "ltr", notes: "", first: "## Next topic" },
    ],
  },
  {
    id: "he-notes",
    md: "# שקף ראשון\n\nתוכן\n\nהערות: לדבר לאט\nולהזכיר את הדדליין\n\n## שקף שני\n\nNote: say thanks",
    slides: [
      { title: "שקף ראשון", dir: "rtl", notes: "לדבר לאט\nולהזכיר את הדדליין", first: "# שקף ראשון" },
      { title: "שקף שני", dir: "rtl", notes: "say thanks", first: "## שקף שני" },
    ],
  },
  {
    id: "comment-notes",
    md: "# Intro\n\nHello <!-- notes: smile --> world",
    slides: [{ title: "Intro", dir: "ltr", notes: "smile", first: "# Intro" }],
  },
  {
    id: "code-fence",
    md: "# קוד\n\n```yaml\n---\n# not a heading\nkey: value\n```\n\n## אחרי",
    slides: [
      { title: "קוד", dir: "rtl", notes: "", first: "# קוד" },
      { title: "אחרי", dir: "rtl", notes: "", first: "## אחרי" },
    ],
  },
  {
    id: "frontmatter-dir",
    md: "---\ntitle: Deck\ndir: rtl\n---\n# Opening\n\n## Second",
    slides: [
      { title: "Opening", dir: "rtl", notes: "", first: "# Opening" },
      { title: "Second", dir: "rtl", notes: "", first: "## Second" },
    ],
  },
  {
    id: "setext",
    md: "שלום\n\nכותרת משנה\n---\n\nתוכן",
    slides: [
      { title: "", dir: "rtl", notes: "", first: "שלום" },
      { title: "כותרת משנה", dir: "rtl", notes: "", first: "## כותרת משנה" },
    ],
  },
  {
    id: "h3-stays",
    md: "# Main\n\n### detail\n\ntext\n\n***\n\n# Last",
    slides: [
      { title: "Main", dir: "ltr", notes: "", first: "# Main" },
      { title: "Last", dir: "ltr", notes: "", first: "# Last" },
    ],
  },
  {
    id: "empty",
    md: "---\ntitle: ריק\n---\n",
    slides: [{ title: "ריק", dir: "rtl", notes: "", first: "# ריק" }],
  },
];
