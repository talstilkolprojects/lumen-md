/**
 * Plan W1.16 — note cards on the canvas: the card element and its link,
 * finding the note a `![[ref]]` names, what a card shows (Hebrew too), the
 * cards as drawn shapes for image export, and cards ↔ JSON Canvas file
 * nodes (4.17).
 */
import { describe, it, expect } from "vitest";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  NOTE_LINK,
  cardPositions,
  cardsForExport,
  isRtlText,
  isVaultNotePath,
  noteExcerpt,
  noteLink,
  notePathOf,
  noteTitle,
  pastedNoteRefs,
  resolveNoteRef,
  wrapLines,
} from "../canvas/noteCards";
import { excalidrawToJsonCanvas, jsonCanvasToExcalidraw, type JsonCanvas } from "../canvas/jsonCanvas";
import type { ExEmbeddableElement, ExShapeElement, ExTextElement, ExcalidrawElement } from "../canvas/tldrawToExcalidraw";

const NOTES = ["Projects/תוכנית.md", "Projects/Plan.md", "Archive/Plan.md", "Plan.md", "Daily/2026-11-10.md", "Reading/ספר טוב.md"];

const card = (id: string, path: string, x = 0, y = 0): ExEmbeddableElement => ({
  id,
  type: "embeddable",
  x,
  y,
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: null,
  roundness: { type: 3 },
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: [{ id: "arrow1", type: "arrow" }],
  updated: 0,
  link: noteLink(path),
  locked: false,
});

describe("the note card element (W1.16)", () => {
  it("links to its vault path; other embeds and paths outside the vault are not cards", () => {
    expect(noteLink("Reading/ספר טוב.md")).toBe(`${NOTE_LINK}Reading/ספר%20טוב.md`);
    expect(notePathOf(card("c", "Reading/ספר טוב.md"))).toBe("Reading/ספר טוב.md");
    expect(notePathOf(card("c", "100%.md"))).toBe("100%.md");
    expect(notePathOf({ type: "embeddable", link: "https://www.youtube.com/watch?v=x" })).toBeNull();
    expect(notePathOf({ type: "rectangle", link: noteLink("Plan.md") })).toBeNull();
    expect(notePathOf({ type: "embeddable", link: `${NOTE_LINK}../secret.md` })).toBeNull();
    expect(notePathOf({ type: "embeddable", link: `${NOTE_LINK}%E0%A4%A` })).toBeNull();
    expect(isVaultNotePath("/etc/passwd.md")).toBe(false);
    expect(isVaultNotePath("a//b.md")).toBe(false);
    expect(isVaultNotePath("javascript:alert(1).md")).toBe(false);
    expect(isVaultNotePath("image.png")).toBe(false);
  });

  it("![[ref]] resolves like Obsidian: a full path, else the shortest path with that name", () => {
    expect(resolveNoteRef("![[Plan]]", NOTES)).toBe("Plan.md");
    expect(resolveNoteRef("[[Projects/Plan|the plan]]", NOTES)).toBe("Projects/Plan.md");
    expect(resolveNoteRef("![[תוכנית#יעדים]]", NOTES)).toBe("Projects/תוכנית.md");
    expect(resolveNoteRef("ספר טוב", NOTES)).toBe("Reading/ספר טוב.md");
    expect(resolveNoteRef("plan.MD", NOTES)).toBe("Plan.md");
    expect(resolveNoteRef("![[Missing]]", NOTES)).toBeNull();
    expect(resolveNoteRef("  ", NOTES)).toBeNull();
    expect(pastedNoteRefs("![[A]]\n  ![[B/C]]\n")).toEqual(["![[A]]", "![[B/C]]"]);
    expect(pastedNoteRefs("see ![[A]]")).toBeNull();
    expect(pastedNoteRefs("")).toBeNull();
  });

  it("a card shows the title (frontmatter, heading or name) and plain first lines", () => {
    const md = "---\ntags: [x]\n---\n# תוכנית הרבעון\n\nשלוש **מטרות** לרבעון, עם [[Plan|התוכנית]].\n\n- [ ] לשלוח את `התקציב`\n- להזמין [אולם](https://example.com)\n\n```js\nnot shown\n```\n> ציטוט";
    expect(noteTitle("Projects/תוכנית.md", md)).toBe("תוכנית הרבעון");
    expect(noteTitle("Projects/תוכנית.md", "---\ntitle: \"כותרת\"\n---\n# Other")).toBe("כותרת");
    expect(noteTitle("Projects/תוכנית.md", "no heading")).toBe("תוכנית");
    expect(noteExcerpt(md)).toBe("שלוש מטרות לרבעון, עם התוכנית.\n\n☐ לשלוח את התקציב\n• להזמין אולם\n\nציטוט");
    expect(noteExcerpt("x".repeat(500), 6, 100)).toHaveLength(100);
  });

  it("new cards go in rows of four from the given point", () => {
    const at = cardPositions(5, { x: 10, y: 20 });
    expect(at[0]).toEqual({ x: 10, y: 20 });
    expect(at[3].x).toBe(10 + 3 * (CARD_WIDTH + 40));
    expect(at[4]).toEqual({ x: 10, y: 20 + CARD_HEIGHT + 40 });
  });
});

describe("cards in image export (W1.16)", () => {
  it("a card becomes a rectangle (same id, so arrows stay bound) with its title and lines; Hebrew aligned right", () => {
    const els = [card("c1", "Projects/תוכנית.md"), card("c2", "Plan.md", 400)] as ExcalidrawElement[];
    const out = cardsForExport(els, (p) => (p === "Plan.md" ? { title: "Plan", excerpt: "First line\nSecond line" } : { title: "תוכנית הרבעון", excerpt: "שלוש מטרות לרבעון" }));
    const rect = out.find((e) => e.id === "c1") as ExShapeElement;
    expect(rect).toMatchObject({ type: "rectangle", link: null, boundElements: [{ id: "arrow1", type: "arrow" }], backgroundColor: "#ffffff" });
    const he = out.filter((e): e is ExTextElement => e.type === "text" && e.id.startsWith("c1~"));
    expect(he.map((e) => [e.id, e.text, e.textAlign])).toEqual([
      ["c1~title", "תוכנית הרבעון", "right"],
      ["c1~body", "שלוש מטרות לרבעון", "right"],
    ]);
    const en = out.filter((e): e is ExTextElement => e.type === "text" && e.id.startsWith("c2~"));
    expect(en.map((e) => e.textAlign)).toEqual(["left", "left"]);
    for (const t of [...he, ...en]) {
      const box = out.find((e) => e.id === t.id.split("~")[0])!;
      expect(t.x >= box.x && t.x + t.width <= box.x + box.width && t.y >= box.y && t.y + t.height <= box.y + box.height, t.id).toBe(true);
    }
  });

  it("a long note is cut to the card with an ellipsis; a missing note shows its name; other elements pass through", () => {
    const long = Array.from({ length: 40 }, (_, i) => `שורה ${i} עם כמה מילים בעברית`).join("\n");
    const other = { ...card("r", "x.md"), type: "rectangle", link: null } as unknown as ExcalidrawElement;
    const out = cardsForExport([card("c", "Long.md") as ExcalidrawElement, other], (p) => (p === "Long.md" ? { title: "ארוך", excerpt: long } : null));
    const body = out.find((e) => e.id === "c~body") as ExTextElement;
    expect(body.y + body.height).toBeLessThanOrEqual(CARD_HEIGHT);
    expect(body.text.endsWith(" …")).toBe(true);
    expect(out.find((e) => e.id === "r")).toBe(other);
    const missing = cardsForExport([card("m", "Folder/Gone.md") as ExcalidrawElement], () => null);
    expect((missing.find((e) => e.id === "m~title") as ExTextElement).text).toBe("Gone");
    expect(wrapLines("a b c", 1000, 16)).toEqual(["a b c"]);
    expect(wrapLines("abcdefghij", 20, 16).every((l) => l.length >= 1)).toBe(true);
    expect(isRtlText("…שלום world")).toBe(true);
    expect(isRtlText("Hello שלום")).toBe(false);
  });

  it("50 cards: titles, excerpts and export shapes in well under a frame budget", () => {
    const md = (i: number) => `# פתק ${i}\n\n${"טקסט בעברית עם English words. ".repeat(20)}`;
    const els = Array.from({ length: 50 }, (_, i) => card(`c${i}`, `Notes/n${i}.md`, (i % 10) * 360, Math.floor(i / 10) * 260)) as ExcalidrawElement[];
    const t0 = performance.now();
    const contents = new Map(els.map((_, i) => [`Notes/n${i}.md`, { title: noteTitle(`n${i}.md`, md(i)), excerpt: noteExcerpt(md(i)) }]));
    const out = cardsForExport(els, (p) => contents.get(p) ?? null);
    const ms = performance.now() - t0;
    expect(out.filter((e) => e.type === "rectangle")).toHaveLength(50);
    expect(ms).toBeLessThan(100);
  });
});

describe("cards ↔ JSON Canvas (W1.16 on 4.17)", () => {
  const canvas: JsonCanvas = {
    nodes: [
      { id: "n1", type: "file", file: "Projects/תוכנית.md", x: 0, y: 0, width: 400, height: 300, color: "4" },
      { id: "n2", type: "file", file: "Plan.md", subpath: "#Goals", x: 500, y: 0, width: 300, height: 200 },
      { id: "img", type: "file", file: "assets/diagram.png", x: 0, y: 400, width: 320, height: 240 },
      { id: "g", type: "group", label: "רבעון", x: -20, y: -20, width: 900, height: 340 },
    ],
    edges: [{ id: "e1", fromNode: "n1", toNode: "n2", label: "מוביל ל" }],
  };

  it("with noteCards, Markdown file nodes are cards (in their group), other files stay rectangles", () => {
    const { file } = jsonCanvasToExcalidraw(JSON.parse(JSON.stringify(canvas)), { noteCards: true });
    const byId = new Map(file.elements.map((e) => [e.id, e]));
    expect(byId.get("n1")).toMatchObject({ type: "embeddable", frameId: "g" });
    expect(notePathOf(byId.get("n1")!)).toBe("Projects/תוכנית.md");
    expect(byId.get("img")?.type).toBe("rectangle");
    const arrow = byId.get("e1") as { startBinding: { elementId: string }; endBinding: { elementId: string } };
    expect([arrow.startBinding.elementId, arrow.endBinding.elementId]).toEqual(["n1", "n2"]);
    expect(file.elements.some((e) => e.type === "text" && e.containerId === "n1")).toBe(false);
  });

  it("a round trip through cards gives the same canvas, subpath and colour kept", () => {
    const { file } = jsonCanvasToExcalidraw(JSON.parse(JSON.stringify(canvas)), { noteCards: true });
    const back = excalidrawToJsonCanvas(JSON.parse(JSON.stringify(file))).canvas;
    expect(back).toEqual(canvas);
  });

  it("a card placed or retargeted in the canvas exports as a file node", () => {
    const { file } = jsonCanvasToExcalidraw(JSON.parse(JSON.stringify(canvas)), { noteCards: true });
    const els = JSON.parse(JSON.stringify(file.elements)) as ExcalidrawElement[];
    els.find((e) => e.id === "n2")!.link = noteLink("Archive/Plan.md");
    els.push({ ...card("new", "Reading/ספר טוב.md", 1000, 0), boundElements: null, customData: undefined } as ExcalidrawElement);
    els.push({ ...card("yt", "x.md", 0, 900), link: "https://www.youtube.com/watch?v=abc", boundElements: null } as ExcalidrawElement);
    const out = excalidrawToJsonCanvas({ elements: els, appState: file.appState });
    const n = (id: string) => out.canvas.nodes.find((x) => x.id === id);
    expect(n("n2")).toEqual({ id: "n2", type: "file", file: "Archive/Plan.md", x: 500, y: 0, width: 300, height: 200 });
    expect(n("new")).toEqual({ id: "new", type: "file", file: "Reading/ספר טוב.md", x: 1000, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT });
    expect(n("yt")).toMatchObject({ type: "link", url: "https://www.youtube.com/watch?v=abc" });
    expect(out.warnings).toEqual([]);
  });
});
