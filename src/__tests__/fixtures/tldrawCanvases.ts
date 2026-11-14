/**
 * Twenty small tldraw canvases for the tldraw → Excalidraw converter tests
 * (plan 4.19 acceptance: "20 tldraw canvases converted without losing a
 * shape"). Generated, not committed as JSON, so each one stays readable.
 *
 * Records follow tldraw 4.x (`richText`, binding records, `{x, y}` arrow
 * terminals, keyed line points); a few canvases use the older stored forms
 * (plain `text`, tldraw 2.x arrow terminals, the legacy store snapshot and
 * the `.tldr` records file) since vaults can hold canvases saved long ago.
 *
 * No imports: the file runs under plain `node --experimental-strip-types`.
 */

export type Rec = { id: string; typeName: string; [key: string]: unknown };

export interface FixtureCanvas {
  name: string;
  /** The stored JSON, in one of the three tldraw formats. */
  data: unknown;
  /** Every record, whatever the stored format. */
  records: Rec[];
}

const PAGE = "page:page";

export function richText(text: string): unknown {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

let indexCounter = 0;
function nextIndex(): string {
  indexCounter++;
  // A valid tldraw index key: integer part "a0", a fraction that never ends in "0".
  return `a0${indexCounter.toString(36).padStart(3, "0")}V`;
}

function shape(
  id: string,
  type: string,
  x: number,
  y: number,
  props: Record<string, unknown>,
  extra: { parentId?: string; rotation?: number; opacity?: number; isLocked?: boolean } = {},
): Rec {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type,
    x,
    y,
    rotation: extra.rotation ?? 0,
    index: nextIndex(),
    parentId: extra.parentId ?? PAGE,
    isLocked: extra.isLocked ?? false,
    opacity: extra.opacity ?? 1,
    props,
    meta: {},
  };
}

const geoDefaults = {
  w: 160,
  h: 90,
  geo: "rectangle",
  color: "black",
  labelColor: "black",
  fill: "none",
  dash: "draw",
  size: "m",
  font: "draw",
  align: "middle",
  verticalAlign: "middle",
  growY: 0,
  url: "",
  scale: 1,
  richText: richText(""),
};

function geo(id: string, x: number, y: number, p: Record<string, unknown> = {}, extra = {}): Rec {
  return shape(id, "geo", x, y, { ...geoDefaults, ...p }, extra);
}

function text(id: string, x: number, y: number, value: string, p: Record<string, unknown> = {}, extra = {}): Rec {
  return shape(
    id,
    "text",
    x,
    y,
    { color: "black", size: "m", font: "draw", textAlign: "start", w: 8, richText: richText(value), scale: 1, autoSize: true, ...p },
    extra,
  );
}

function note(id: string, x: number, y: number, value: string, p: Record<string, unknown> = {}, extra = {}): Rec {
  return shape(
    id,
    "note",
    x,
    y,
    {
      color: "yellow",
      labelColor: "black",
      size: "m",
      font: "draw",
      fontSizeAdjustment: 0,
      align: "middle",
      verticalAlign: "middle",
      growY: 0,
      url: "",
      richText: richText(value),
      scale: 1,
      ...p,
    },
    extra,
  );
}

function frame(id: string, x: number, y: number, w: number, h: number, name: string, extra = {}): Rec {
  return shape(id, "frame", x, y, { w, h, name, color: "black" }, extra);
}

function group(id: string, extra = {}): Rec {
  return shape(id, "group", 0, 0, {}, extra);
}

function arrow(
  id: string,
  x: number,
  y: number,
  end: { x: number; y: number },
  p: Record<string, unknown> = {},
  extra = {},
): Rec {
  return shape(
    id,
    "arrow",
    x,
    y,
    {
      kind: "arc",
      labelColor: "black",
      color: "black",
      fill: "none",
      dash: "draw",
      size: "m",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      font: "draw",
      start: { x: 0, y: 0 },
      end,
      bend: 0,
      richText: richText(""),
      labelPosition: 0.5,
      scale: 1,
      elbowMidPoint: 0.5,
      ...p,
    },
    extra,
  );
}

function binding(arrowId: string, targetId: string, terminal: "start" | "end", anchor = { x: 0.5, y: 0.5 }): Rec {
  return {
    id: `binding:${arrowId}-${terminal}`,
    typeName: "binding",
    type: "arrow",
    fromId: `shape:${arrowId}`,
    toId: `shape:${targetId}`,
    props: { terminal, normalizedAnchor: anchor, isExact: false, isPrecise: anchor.x !== 0.5 || anchor.y !== 0.5, snap: "none" },
    meta: {},
  };
}

function line(id: string, x: number, y: number, pts: [number, number][], p: Record<string, unknown> = {}, extra = {}): Rec {
  const points: Record<string, unknown> = {};
  pts.forEach(([px, py], i) => {
    const pid = `a${i + 1}`;
    points[pid] = { id: pid, index: pid, x: px, y: py };
  });
  return shape(id, "line", x, y, { color: "black", dash: "draw", size: "m", spline: "line", points, scale: 1, ...p }, extra);
}

function draw(id: string, x: number, y: number, pts: [number, number, number][], p: Record<string, unknown> = {}, extra = {}): Rec {
  return shape(
    id,
    "draw",
    x,
    y,
    {
      color: "black",
      fill: "none",
      dash: "draw",
      size: "m",
      segments: [{ type: "free", points: pts.map(([px, py, z]) => ({ x: px, y: py, z })) }],
      isComplete: true,
      isClosed: false,
      isPen: false,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      ...p,
    },
    extra,
  );
}

/** A 1×1 transparent PNG. */
export const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function asset(id: string, src: string, w = 1, h = 1): Rec {
  return {
    id: `asset:${id}`,
    typeName: "asset",
    type: "image",
    props: { name: `${id}.png`, src, w, h, mimeType: "image/png", isAnimated: false, fileSize: 68 },
    meta: {},
  };
}

function image(id: string, x: number, y: number, assetId: string | null, p: Record<string, unknown> = {}, extra = {}): Rec {
  return shape(
    id,
    "image",
    x,
    y,
    { w: 120, h: 80, playing: true, url: "", assetId: assetId ? `asset:${assetId}` : null, crop: null, flipX: false, flipY: false, altText: "", ...p },
    extra,
  );
}

function page(id: string, name: string, index: string): Rec {
  return { id, typeName: "page", name, index, meta: {} };
}

const DOCUMENT: Rec = { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} };

/** What `getSnapshot(editor.store)` returns — the format the app saves today. */
function editorSnapshot(records: Rec[]): unknown {
  return {
    document: {
      store: Object.fromEntries(records.map((r) => [r.id, r])),
      schema: { schemaVersion: 2, sequences: {} },
    },
    session: { version: 0, currentPageId: PAGE, isGridMode: false, pageStates: [] },
  };
}

function canvas(name: string, shapes: Rec[], extraRecords: Rec[] = [], format: "editor" | "store" | "tldr" = "editor"): FixtureCanvas {
  const pages = extraRecords.some((r) => r.typeName === "page") ? [] : [page(PAGE, "Page 1", "a1")];
  const records = [DOCUMENT, ...pages, ...extraRecords, ...shapes];
  let data: unknown;
  if (format === "editor") data = editorSnapshot(records);
  else if (format === "store") data = { store: Object.fromEntries(records.map((r) => [r.id, r])), schema: { schemaVersion: 2 } };
  else data = { tldrawFileFormatVersion: 1, schema: { schemaVersion: 2, sequences: {} }, records };
  return { name, data, records };
}

/** Deterministic PRNG (mulberry32) for the large mixed canvas. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildFixtureCanvases(): FixtureCanvas[] {
  indexCounter = 0;
  const out: FixtureCanvas[] = [];

  // 1. Basic geo shapes with Hebrew and English labels.
  out.push(
    canvas("01-geo-basic", [
      geo("r1", 0, 0, { richText: richText("שלום עולם"), fill: "solid", color: "blue" }),
      geo("e1", 220, 0, { geo: "ellipse", richText: richText("Hello"), fill: "semi", color: "green" }),
      geo("d1", 440, 0, { geo: "diamond", richText: richText("החלטה?\nכן / לא"), dash: "dashed", size: "l" }),
      geo("r2", 0, 160, { w: 300, h: 60, growY: 20, dash: "dotted", color: "red", url: "https://example.com" }),
    ]),
  );

  // 2. Every other geo kind.
  const kinds = [
    "triangle", "trapezoid", "rhombus", "rhombus-2", "pentagon", "hexagon", "octagon", "star",
    "arrow-right", "arrow-left", "arrow-up", "arrow-down", "cloud", "heart", "oval", "check-box", "x-box",
  ];
  out.push(
    canvas(
      "02-geo-kinds",
      kinds.map((k, i) => geo(`k${i}`, (i % 6) * 200, Math.floor(i / 6) * 150, { geo: k, richText: richText(i % 2 ? k : `צורה ${i}`) })),
    ),
  );

  // 3. Text: Hebrew, English, mixed, multi-line, every alignment, fixed width.
  out.push(
    canvas("03-text", [
      text("t1", 0, 0, "כותרת בעברית"),
      text("t2", 0, 60, "English heading"),
      text("t3", 0, 120, "עברית with English באמצע", { textAlign: "middle" }),
      text("t4", 0, 180, "שורה ראשונה\nשורה שנייה\nשורה שלישית", { textAlign: "end", size: "s" }),
      text("t5", 0, 300, "Fixed width paragraph that wraps", { autoSize: false, w: 200, size: "l", font: "sans" }),
      text("t6", 0, 400, "קוד: const x = 1;", { font: "mono", size: "xl", color: "violet" }),
    ]),
  );

  // 4. Sticky notes in several colours.
  out.push(
    canvas(
      "04-notes",
      ["yellow", "blue", "green", "red", "violet", "black"].map((c, i) =>
        note(`n${i}`, i * 220, 0, i % 2 ? `Note ${i}` : `פתק ${i}`, { color: c, size: i % 2 ? "s" : "l" }),
      ),
    ),
  );

  // 5. Arrows bound at both ends, with labels.
  out.push(
    canvas(
      "05-arrows-bound",
      [
        geo("a", 0, 0, { richText: richText("התחלה") }),
        geo("b", 400, 0, { richText: richText("סוף") }),
        geo("c", 400, 300, { geo: "ellipse" }),
        arrow("ab", 160, 45, { x: 240, y: 0 }, { richText: richText("הבא") }),
        arrow("bc", 480, 90, { x: 0, y: 210 }, { color: "blue" }),
        arrow("ca", 400, 345, { x: -320, y: -255 }, { bend: 40 }),
      ],
      [
        binding("ab", "a", "start"),
        binding("ab", "b", "end"),
        binding("bc", "b", "start"),
        binding("bc", "c", "end", { x: 0.5, y: 0 }),
        binding("ca", "c", "start", { x: 0, y: 0.5 }),
        binding("ca", "a", "end", { x: 0.5, y: 1 }),
      ],
    ),
  );

  // 6. Free arrows: bends and every arrowhead.
  const heads = ["arrow", "triangle", "square", "dot", "pipe", "diamond", "inverted", "bar", "none"];
  out.push(
    canvas(
      "06-arrows-free",
      heads.map((h, i) =>
        arrow(`h${i}`, 0, i * 60, { x: 300, y: 0 }, { arrowheadStart: heads[(i + 3) % heads.length], arrowheadEnd: h, bend: i % 3 === 0 ? -30 : 0, size: ["s", "m", "l", "xl"][i % 4] }),
      ),
    ),
  );

  // 7. Elbow arrow, and an arrow whose binding target was deleted.
  out.push(
    canvas(
      "07-arrows-edge",
      [
        geo("box", 0, 0),
        arrow("elbow", 160, 45, { x: 200, y: 150 }, { kind: "elbow" }),
        arrow("dangling", 0, 200, { x: 200, y: 0 }),
      ],
      [binding("elbow", "box", "start"), binding("dangling", "ghost", "end")],
    ),
  );

  // 8. Frames with children.
  out.push(
    canvas("08-frames", [
      frame("f1", 0, 0, 500, 300, "מסגרת א"),
      geo("in1", 20, 40, { richText: richText("בתוך המסגרת") }, { parentId: "shape:f1" }),
      text("in2", 250, 40, "inside", {}, { parentId: "shape:f1" }),
      note("in3", 250, 80, "פתק במסגרת", {}, { parentId: "shape:f1" }),
      frame("f2", 600, 0, 300, 300, ""),
      arrow("fa", 100, 150, { x: 600, y: 0 }),
    ], [binding("fa", "in1", "start"), binding("fa", "f2", "end")]),
  );

  // 9. Nested frames.
  out.push(
    canvas("09-nested-frames", [
      frame("outer", 0, 0, 800, 600, "Outer"),
      frame("inner", 50, 50, 400, 300, "פנימית", { parentId: "shape:outer" }),
      geo("deep", 20, 40, { geo: "ellipse" }, { parentId: "shape:inner" }),
      geo("shallow", 500, 400, {}, { parentId: "shape:outer" }),
    ]),
  );

  // 10. Groups, nested.
  out.push(
    canvas("10-groups", [
      group("g1", {}),
      geo("g1a", 0, 0, {}, { parentId: "shape:g1" }),
      group("g2", { parentId: "shape:g1" }),
      geo("g2a", 200, 0, { geo: "ellipse" }, { parentId: "shape:g2" }),
      text("g2b", 200, 120, "קבוצה פנימית", {}, { parentId: "shape:g2" }),
    ]),
  );

  // 11. Embedded images: plain, cropped, flipped; two shapes share an asset.
  out.push(
    canvas(
      "11-images",
      [
        image("i1", 0, 0, "png1"),
        image("i2", 200, 0, "png2", { crop: { topLeft: { x: 0.25, y: 0 }, bottomRight: { x: 1, y: 0.5 } } }),
        image("i3", 400, 0, "png1", { flipX: true }),
      ],
      [asset("png1", PNG_DATA_URL), asset("png2", PNG_DATA_URL, 400, 200)],
    ),
  );

  // 12. Images that can't be embedded: a remote URL and a missing asset.
  out.push(
    canvas(
      "12-images-missing",
      [image("remote", 0, 0, "web"), image("gone", 200, 0, "nothere"), image("noasset", 400, 0, null)],
      [asset("web", "https://example.com/picture.png")],
    ),
  );

  // 13. Freehand: mouse, pen with pressure, closed and filled, highlighter.
  out.push(
    canvas("13-draw", [
      draw("d1", 0, 0, [[0, 0, 0.5], [10, 5, 0.5], [20, 15, 0.5], [40, 20, 0.5]]),
      draw("d2", 100, 0, [[0, 0, 0.2], [5, 10, 0.6], [10, 30, 0.9]], { isPen: true, color: "red" }),
      draw("d3", 200, 0, [[0, 0, 0.5], [50, 0, 0.5], [50, 50, 0.5], [0, 50, 0.5]], { isClosed: true, fill: "solid", color: "green" }),
      shape("hl", "highlight", 300, 0, {
        color: "yellow",
        size: "l",
        segments: [{ type: "free", points: [{ x: 0, y: 0, z: 0.5 }, { x: 80, y: 0, z: 0.5 }] }],
        isComplete: true,
        isPen: false,
        scale: 1,
        scaleX: 1,
        scaleY: 1,
      }),
      draw("d4", 400, 0, [[0, 0, 0.5], [10, 10, 0.5]], {
        segments: [
          { type: "straight", points: [{ x: 0, y: 0, z: 0.5 }, { x: 30, y: 0, z: 0.5 }] },
          { type: "straight", points: [{ x: 30, y: 0, z: 0.5 }, { x: 30, y: 30, z: 0.5 }] },
        ],
        scaleX: 2,
        scaleY: 0.5,
      }),
    ]),
  );

  // 14. Lines: straight and cubic.
  out.push(
    canvas("14-lines", [
      line("l1", 0, 0, [[0, 0], [100, 0], [100, 100]]),
      line("l2", 200, 0, [[0, 0], [50, 80], [100, 0], [150, 80]], { spline: "cubic", dash: "dashed", color: "orange" }),
    ]),
  );

  // 15. Rotation, opacity, lock — including a rotated frame with a child.
  out.push(
    canvas("15-rotation", [
      geo("rot", 100, 100, { richText: richText("מסובב") }, { rotation: Math.PI / 4 }),
      text("rt", 400, 100, "rotated", {}, { rotation: Math.PI / 2 }),
      frame("rf", 0, 400, 300, 200, "", { rotation: Math.PI / 6 }),
      geo("rfc", 50, 50, { w: 100, h: 50 }, { parentId: "shape:rf" }),
      geo("faded", 600, 100, {}, { opacity: 0.4, isLocked: true }),
      arrow("ra", 600, 400, { x: 100, y: 0 }, {}, { rotation: Math.PI / 2 }),
      // `scale` (tldraw's dynamic size): sizes labels and strokes; w, h and arrow terminals are page units.
      geo("big", 900, 0, { w: 100, h: 50, growY: 10, scale: 2, richText: richText("גדול") }),
      arrow("sarr", 900, 300, { x: 100, y: 50 }, { scale: 2 }),
      arrow("sbent", 900, 500, { x: 100, y: 0 }, { scale: 2, bend: 20 }),
      arrow("lbent", 900, 900, { x: 100, y: 0 }, { scale: 2, bend: 20, richText: richText("רבע"), labelPosition: 0.25 }),
      line("sline", 900, 700, [[0, 0], [100, 50]], { scale: 2 }),
    ]),
  );

  // 16. Two pages.
  out.push(
    canvas(
      "16-pages",
      [
        geo("p1a", 0, 0, { richText: richText("עמוד 1") }),
        geo("p2a", 0, 0, { richText: richText("עמוד 2") }, { parentId: "page:two" }),
        text("p2b", 0, 200, "second page", {}, { parentId: "page:two" }),
      ],
      [page(PAGE, "Page 1", "a1"), page("page:two", "עמוד שני", "a2")],
    ),
  );

  // 17. The legacy store snapshot that `convertLegacyCanvas` writes (notes with plain `text`).
  out.push(
    canvas(
      "17-legacy-store",
      [
        { ...note("legacy-1", 0, 0, ""), props: { color: "blue", size: "m", text: "Old note", font: "draw" } },
        { ...note("legacy-2", 240, 0, ""), props: { color: "blue", size: "m", text: "פתק ישן", font: "draw" } },
      ],
      [],
      "store",
    ),
  );

  // 18. A `.tldr` file with tldraw 2.x arrow terminals (binding inside the arrow).
  out.push(
    canvas(
      "18-tldr-v2",
      [
        { ...geo("old1", 0, 0), props: { ...geoDefaults, richText: undefined, text: "ישן" } },
        geo("old2", 400, 0),
        arrow("oldarrow", 0, 0, { x: 0, y: 0 }, {
          start: { type: "binding", boundShapeId: "shape:old1", normalizedAnchor: { x: 1, y: 0.5 }, isExact: false },
          end: { type: "binding", boundShapeId: "shape:old2", normalizedAnchor: { x: 0, y: 0.5 }, isExact: false },
          richText: undefined,
          text: "",
        }),
        arrow("pointarrow", 0, 200, { x: 0, y: 0 }, { start: { type: "point", x: 0, y: 0 }, end: { type: "point", x: 150, y: 50 } }),
      ],
      [],
      "tldr",
    ),
  );

  // 19. Shapes with no Excalidraw element: video, embed, bookmark, a custom shape.
  out.push(
    canvas("19-unsupported", [
      shape("vid", "video", 0, 0, { w: 320, h: 180, assetId: "asset:clip", url: "", time: 0, playing: false, autoplay: false, altText: "" }),
      shape("emb", "embed", 400, 0, { w: 320, h: 180, url: "https://example.com/embed" }),
      shape("bm", "bookmark", 0, 300, { w: 300, h: 320, url: "https://example.com/article", assetId: null }),
      shape("custom", "lumen-card", 400, 300, { w: 200, h: 100, text: "כרטיס" }),
    ], [
      {
        id: "asset:clip",
        typeName: "asset",
        type: "video",
        props: { name: "clip.mp4", src: "https://example.com/clip.mp4", w: 320, h: 180, mimeType: "video/mp4", isAnimated: true, fileSize: 1000 },
        meta: {},
      },
    ]),
  );

  // 20. A larger mixed canvas, deterministic.
  const rand = prng(4190);
  const mixed: Rec[] = [frame("mf", 0, 0, 2000, 1500, "לוח גדול")];
  const bindings: Rec[] = [];
  const targets: string[] = [];
  for (let i = 0; i < 60; i++) {
    const x = Math.round(rand() * 1800);
    const y = Math.round(rand() * 1300);
    const parentId = i % 3 === 0 ? "shape:mf" : PAGE;
    const pick = i % 6;
    const label = i % 2 ? `item ${i}` : `פריט ${i}`;
    if (pick === 0) mixed.push(geo(`m${i}`, x, y, { richText: richText(label), geo: ["rectangle", "ellipse", "diamond"][i % 3] }, { parentId }));
    else if (pick === 1) mixed.push(text(`m${i}`, x, y, label, {}, { parentId }));
    else if (pick === 2) mixed.push(note(`m${i}`, x, y, label, {}, { parentId }));
    else if (pick === 3) mixed.push(draw(`m${i}`, x, y, [[0, 0, 0.5], [rand() * 50, rand() * 50, 0.5], [rand() * 90, rand() * 90, 0.5]], {}, { parentId }));
    else if (pick === 4) mixed.push(line(`m${i}`, x, y, [[0, 0], [rand() * 100, rand() * 100]], {}, { parentId }));
    else mixed.push(geo(`m${i}`, x, y, { geo: "hexagon" }, { parentId, rotation: rand() }));
    if (pick === 0 || pick === 2) targets.push(`m${i}`);
  }
  for (let i = 0; i + 1 < targets.length; i += 2) {
    const id = `ma${i}`;
    mixed.push(arrow(id, 10, 10, { x: 100, y: 100 }));
    bindings.push(binding(id, targets[i], "start"), binding(id, targets[i + 1], "end"));
  }
  out.push(canvas("20-mixed", mixed, bindings));

  return out;
}
