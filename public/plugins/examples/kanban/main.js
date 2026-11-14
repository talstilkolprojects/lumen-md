// Kanban — a Lumen plugin (plan W4.32; the Kanban idea, written from
// scratch). A ```kanban block is plain Markdown — a heading per column, a
// list item per card — so the note stays readable anywhere; the plugin
// draws it as columns. "Export" copies the board as a Markdown table.
//
//     ```kanban
//     ## לעשות
//     - לכתוב סיכום [[שיעור 3]]
//     ## בתהליך
//     - תרגיל 2
//     ## בוצע
//     - [x] תרגיל 1
//     ```

/** Columns of a board: [{ title, cards: [{ text, done }] }]. Lines before the first heading form an untitled column. */
function parseBoard(source) {
  const columns = [];
  let col = null;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      col = { title: h[1].trim(), cards: [] };
      columns.push(col);
      continue;
    }
    const item = /^\s*[-*+]\s+(?:\[( |x|X)\]\s+)?(.+)$/.exec(line);
    if (!item) continue;
    if (!col) {
      col = { title: "", cards: [] };
      columns.push(col);
    }
    col.cards.push({ text: item[2].trim(), done: item[1] === "x" || item[1] === "X" });
  }
  return columns;
}

/** Card text with [[links]] as note links. */
function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "noteLink", target: m[1].trim(), label: (m[2] ?? m[1]).trim() });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

function boardTree(columns) {
  if (!columns.length) return { type: "text", text: "Empty board: add “## Column” headings and “- card” items. · לוח ריק: מוסיפים כותרות „## עמודה” ופריטים „- כרטיס”." };
  return {
    type: "box",
    direction: "row",
    gap: 12,
    children: columns.map((c) => ({
      type: "box",
      gap: 4,
      children: [
        { type: "heading", level: 3, text: `${c.title || "—"} (${c.cards.length})` },
        c.cards.length
          ? { type: "list", items: c.cards.map((k) => (k.done ? [{ type: "text", text: "✓ " }, ...inline(k.text)] : inline(k.text))) }
          : { type: "text", text: "—" },
      ],
    })),
  };
}

const cell = (s) => s.replace(/\|/g, "\\|");

/** The board as a Markdown table: one column per board column, one row per card position. */
function toTable(columns) {
  if (!columns.length) return "";
  const rows = Math.max(...columns.map((c) => c.cards.length));
  const head = `| ${columns.map((c) => cell(c.title || "—")).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = [];
  for (let i = 0; i < rows; i++) body.push(`| ${columns.map((c) => (c.cards[i] ? cell((c.cards[i].done ? "✓ " : "") + c.cards[i].text) : "")).join(" | ")} |`);
  return [head, sep, ...body].join("\n") + "\n";
}

/** The source of every ```kanban block of a note. */
function boardsIn(text) {
  const out = [];
  const re = /^ {0,3}(`{3,}|~{3,})[ \t]*kanban[ \t]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[2]);
  return out;
}

lumen.on("render:kanban", async ({ requestId, source }) => {
  await lumen.renderer.result(requestId, boardTree(parseBoard(source)));
});

await lumen.renderer.register("kanban");

await lumen.commands.register({ id: "new", label: "New Kanban board", hint: "Inserts a three-column board · לוח קנבן חדש" }, async () => {
  await lumen.document.insertText("```kanban\n## To do\n- \n## Doing\n## Done\n```\n");
});

await lumen.commands.register({ id: "export", label: "Copy Kanban board as a table", hint: "The first board of this note · ייצוא לוח כטבלה" }, async () => {
  const [board] = boardsIn(await lumen.document.getText());
  if (board === undefined) return lumen.notifications.show("No ```kanban board in this note. · אין לוח קנבן בפתק הזה.", "info");
  await lumen.clipboard.writeText(toTable(parseBoard(board)));
  await lumen.notifications.show("Board copied as a table. · הלוח הועתק כטבלה.", "success");
});
