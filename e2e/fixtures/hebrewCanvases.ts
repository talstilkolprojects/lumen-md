/**
 * Plan W1.16 — the 20 golden canvases with Hebrew for the export check:
 * Hebrew, Latin and mixed text in every alignment, in the hand-drawn and
 * the plain fonts, inside shapes, on arrows, in frame names and on note
 * cards. Plain Excalidraw JSON (Excalidraw's restore fills the rest).
 */

type El = Record<string, unknown>;
let seq = 0;
const base = (type: string, x: number, y: number, width: number, height: number, extra: El = {}): El => ({
  id: `g${++seq}`,
  type,
  x,
  y,
  width,
  height,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: seq,
  version: 1,
  versionNonce: seq,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...extra,
});
const text = (s: string, x: number, y: number, o: { align?: "left" | "center" | "right"; font?: number; size?: number; width?: number; containerId?: string } = {}): El => {
  const size = o.size ?? 20;
  const lines = s.split("\n");
  return base("text", x, y, o.width ?? Math.max(...lines.map((l) => l.length)) * size * 0.6, lines.length * size * 1.25, {
    text: s,
    originalText: s,
    fontSize: size,
    fontFamily: o.font ?? 5,
    textAlign: o.align ?? "left",
    verticalAlign: o.containerId ? "middle" : "top",
    containerId: o.containerId ?? null,
    autoResize: !o.width,
    lineHeight: 1.25,
  });
};
const boxed = (type: string, s: string, x: number, y: number, w: number, h: number, font = 5): El[] => {
  const shape = base(type, x, y, w, h, { roundness: type === "rectangle" ? { type: 3 } : null });
  const label = text(s, x + 10, y + h / 2 - 12, { align: "center", width: w - 20, containerId: shape.id as string, font });
  shape.boundElements = [{ id: label.id, type: "text" }];
  return [shape, label];
};
const card = (path: string, x: number, y: number): El => base("embeddable", x, y, 320, 220, { link: `lumen-note:${encodeURI(path)}`, strokeWidth: 1, roundness: { type: 3 } });

export interface GoldenCanvas {
  name: string;
  elements: El[];
  /** Notes the canvas's cards show. */
  notes?: Record<string, string>;
}

const scene = (name: string, elements: El[], notes?: Record<string, string>): GoldenCanvas => ({ name, elements, notes });

export const GOLDEN_CANVASES: GoldenCanvas[] = [
  scene("he-left", [text("שלום עולם", 0, 0)]),
  scene("he-right", [text("שלום עולם", 0, 0, { align: "right", width: 300 })]),
  scene("he-center", [text("שלום עולם", 0, 0, { align: "center", width: 300 })]),
  scene("he-multiline", [text("שורה ראשונה\nשורה שנייה, ארוכה יותר\nשלישית.", 0, 0, { align: "right", width: 360 })]),
  scene("mixed-he-first", [text("סיכום Q3: הכנסות 1.2M ש״ח!", 0, 0)]),
  scene("mixed-en-first", [text("Q3 summary: הכנסות עלו ב-12%", 0, 0)]),
  scene("mixed-lines", [text("Agenda:\nתקציב 2026\nMarketing — שיווק", 0, 0, { align: "right", width: 320 })]),
  scene("he-nunito", [text("גופן פשוט — Nunito", 0, 0, { font: 6 })]),
  scene("he-lilita", [text("כותרת גדולה", 0, 0, { font: 7, size: 36 })]),
  scene("he-cascadia", [text("קוד: const x = 1; // הערה", 0, 0, { font: 3 })]),
  scene("he-comic", [text("כתב יד שובב", 0, 0, { font: 8 })]),
  scene("rect-label", boxed("rectangle", "משימה פתוחה", 0, 0, 260, 100)),
  scene("ellipse-label", boxed("ellipse", "רעיון", 0, 0, 200, 120)),
  scene("diamond-label", boxed("diamond", "האם לאשר?", 0, 0, 240, 160)),
  scene("flow", [
    ...boxed("rectangle", "התחלה", 0, 0, 180, 80),
    ...boxed("rectangle", "סוף", 400, 0, 180, 80),
    base("arrow", 180, 40, 220, 0, { points: [[0, 0], [220, 0]], endArrowhead: "arrow", startArrowhead: null, lastCommittedPoint: null, startBinding: null, endBinding: null }),
    text("מעבר", 260, 10, { size: 16 }),
  ]),
  scene("frame-name", [base("frame", 0, 0, 500, 300, { name: "רבעון שלישי" }), text("בתוך המסגרת", 40, 60)]),
  scene("numbers-dates", [text("פגישה ב-10.11.2026 בשעה 14:30 (שעה וחצי)", 0, 0)]),
  scene("niqqud", [text("בְּרֵאשִׁית בָּרָא אֱלֹהִים", 0, 0, { size: 28 })]),
  scene("note-card-he", [card("Notes/תוכנית.md", 0, 0)], { "Notes/תוכנית.md": "# תוכנית הרבעון\n\nשלוש מטרות לרבעון:\n- להגדיל מכירות\n- לגייס שניים\n- Launch v2" }),
  scene("note-cards-mixed", [card("Notes/Plan.md", 0, 0), card("Notes/סיכום.md", 360, 0), base("arrow", 320, 110, 40, 0, { points: [[0, 0], [40, 0]], endArrowhead: "arrow", startArrowhead: null, lastCommittedPoint: null, startBinding: null, endBinding: null })], {
    "Notes/Plan.md": "# Plan\n\nShip on Tuesday.",
    "Notes/סיכום.md": "# סיכום\n\nמשלוחים ביום שלישי.",
  }),
];

export function goldenFile(c: GoldenCanvas): string {
  return JSON.stringify({ type: "excalidraw", version: 2, source: "lumen-golden", elements: c.elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} });
}
