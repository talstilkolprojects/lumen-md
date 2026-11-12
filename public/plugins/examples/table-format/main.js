// Table formatter — a Lumen plugin (plan W4.32; the Advanced Tables idea,
// written from scratch). Lines up the pipes of every Markdown table in the
// note, keeps each column's alignment (:--, :-:, --:), and sorts the table
// under the cursor by the column the cursor is in. Widths count what the
// eye sees: Hebrew niqqud and other combining marks take no room, CJK and
// emoji take two.

/** Display width of a string. */
function width(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (/\p{M}/u.test(ch) || c === 0x200d || c === 0x200e || c === 0x200f || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return w;
}

/** Cells of a table row (escaped pipes stay in the cell). */
function cells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (s[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Tables of the text outside code fences: { start, end (line indexes, end exclusive) }. */
function findTables(lines) {
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (lines[i].includes("|") && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      let end = i + 2;
      while (end < lines.length && lines[end].includes("|") && lines[end].trim()) end++;
      out.push({ start: i, end });
      i = end - 1;
    }
  }
  return out;
}

function alignOf(sep) {
  const s = sep.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  if (s.startsWith(":")) return "left";
  return "none";
}

function padCell(text, w, align) {
  const gap = w - width(text);
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
  return text + " ".repeat(gap);
}

/** One table's lines, formatted. */
function formatTable(rows) {
  const header = cells(rows[0]);
  const aligns = cells(rows[1]).map(alignOf);
  const body = rows.slice(2).map(cells);
  const n = Math.max(header.length, aligns.length, ...body.map((r) => r.length));
  const all = [header, ...body].map((r) => Array.from({ length: n }, (_, i) => r[i] ?? ""));
  while (aligns.length < n) aligns.push("none");
  const widths = Array.from({ length: n }, (_, i) => Math.max(3, ...all.map((r) => width(r[i]))));
  const line = (r) => `| ${r.map((c, i) => padCell(c, widths[i], aligns[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w, i) => (aligns[i] === "center" ? `:${"-".repeat(w - 2)}:` : aligns[i] === "right" ? `${"-".repeat(w - 1)}:` : aligns[i] === "left" ? `:${"-".repeat(w - 1)}` : "-".repeat(w))).join(" | ")} |`;
  return [line(all[0]), sep, ...all.slice(1).map(line)];
}

/** Compare for sorting: numbers by value; text without niqqud, final letters as their regular forms. */
function sortKey(s) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[*_`~]/g, "").replace(/ך/g, "כ").replace(/ם/g, "מ").replace(/ן/g, "נ").replace(/ף/g, "פ").replace(/ץ/g, "צ").toLowerCase();
}
function compare(a, b) {
  const na = Number(a.replace(/[,\s]/g, ""));
  const nb = Number(b.replace(/[,\s]/g, ""));
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const ka = sortKey(a);
  const kb = sortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

async function formatAll() {
  const text = await lumen.document.getText();
  const lines = text.split("\n");
  const tables = findTables(lines);
  for (const t of tables.reverse()) lines.splice(t.start, t.end - t.start, ...formatTable(lines.slice(t.start, t.end)));
  const next = lines.join("\n");
  if (next !== text) await lumen.document.setText(next);
}

/** Sort the table under the cursor by the cursor's column. */
async function sortAtCursor(desc) {
  const text = await lumen.document.getText();
  const sel = await lumen.document.getSelection();
  const at = sel ? sel.from : 0;
  const lines = text.split("\n");
  let pos = 0;
  let row = 0;
  for (; row < lines.length; row++) {
    if (at <= pos + lines[row].length) break;
    pos += lines[row].length + 1;
  }
  const t = findTables(lines).find((x) => row >= x.start && row < x.end);
  if (!t) return;
  const before = lines[row].slice(0, Math.max(0, at - pos));
  const col = Math.max(0, cells(before + "x").length - 1);
  const formatted = formatTable(lines.slice(t.start, t.end));
  const body = formatted.slice(2).map((l) => ({ l, key: cells(l)[col] ?? "" }));
  body.sort((a, b) => (desc ? -1 : 1) * compare(a.key, b.key));
  lines.splice(t.start, t.end - t.start, formatted[0], formatted[1], ...body.map((b) => b.l));
  await lumen.document.setText(lines.join("\n"));
}

await lumen.commands.register({ id: "format", label: "Format tables", hint: "Line up every table in this note · יישור טבלאות" }, formatAll);
await lumen.commands.register({ id: "sort-asc", label: "Sort table by this column (A→Z, 1→9)", hint: "The table under the cursor · מיון טבלה" }, () => sortAtCursor(false));
await lumen.commands.register({ id: "sort-desc", label: "Sort table by this column (Z→A, 9→1)", hint: "The table under the cursor · מיון טבלה בסדר יורד" }, () => sortAtCursor(true));
