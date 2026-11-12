// Note refactor — a Lumen plugin (plan W4.32; the Note Refactor idea,
// written from scratch). "Extract selection to a new note": the selected
// text becomes a note of its own, named after its first line, and a
// [[link]] takes its place. "Split note by headings": every section under
// a heading of the chosen level becomes a note, and the original keeps a
// list of links. Existing notes are never overwritten — a name that is
// taken gets " 2", " 3"…

/** A file name from a line of text: no Markdown marks, no characters file systems refuse. */
function noteName(line) {
  const name = line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return name || "Untitled";
}

/** The folder of the open note ("" at the vault root). */
function folderOf(fileName) {
  const i = String(fileName || "").lastIndexOf("/");
  return i < 0 ? "" : fileName.slice(0, i);
}

async function freePath(folder, name) {
  let existing = [];
  try {
    existing = (await lumen.vault.list(folder)).map((e) => e.name.toLowerCase());
  } catch {
    existing = [];
  }
  const taken = new Set(existing);
  let n = 1;
  let candidate = name;
  while (taken.has(`${candidate}.md`.toLowerCase())) candidate = `${name} ${++n}`;
  return { path: (folder ? `${folder}/` : "") + `${candidate}.md`, title: candidate };
}

async function extract() {
  const sel = await lumen.document.getSelection();
  const text = sel && sel.text ? sel.text : "";
  if (!text.trim()) return lumen.notifications.show("Select the text to move first. · קודם מסמנים את הטקסט להעברה.", "info");
  const lines = text.replace(/^\n+/, "").split("\n");
  const first = lines[0];
  const isHeading = /^\s*#{1,6}\s+/.test(first);
  const folder = folderOf(await lumen.document.getFileName());
  const { path, title } = await freePath(folder, noteName(first));
  const body = (isHeading ? lines.slice(1).join("\n").replace(/^\n+/, "") : lines.join("\n")).replace(/\s+$/, "") + "\n";
  await lumen.vault.write(path, `# ${title}\n\n${body}`);
  await lumen.document.replaceSelection(`[[${title}]]${text.endsWith("\n") ? "\n" : ""}`);
  await lumen.notifications.show(`Moved to “${title}”. · הועבר אל „${title}”.`, "success");
}

/** Sections of a note under headings of `level`: { title, start, end } (line indexes), code fences skipped. */
function sections(lines, level) {
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
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (m[1].length <= level && out.length && out[out.length - 1].end === -1) out[out.length - 1].end = i;
    if (m[1].length === level) out.push({ title: m[2], start: i, end: -1 });
  }
  if (out.length && out[out.length - 1].end === -1) out[out.length - 1].end = lines.length;
  return out;
}

async function split(payload) {
  const s = await lumen.settings.get();
  const level = payload && Number.isInteger(payload.level) ? payload.level : Number.isInteger(s.level) ? s.level : 2;
  const text = await lumen.document.getText();
  const lines = text.split("\n");
  const secs = sections(lines, level);
  if (!secs.length) return lumen.notifications.show(`No level-${level} headings in this note. · אין בפתק כותרות ברמה ${level}.`, "info");
  const folder = folderOf(await lumen.document.getFileName());
  const links = [];
  for (const sec of secs) {
    const { path, title } = await freePath(folder, noteName(sec.title));
    const body = lines.slice(sec.start + 1, sec.end).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
    await lumen.vault.write(path, `# ${title}\n\n${body}\n`);
    links.push(`- [[${title}]]`);
  }
  // Each section is replaced by its link; whatever lies between sections stays.
  const out = [];
  let at = 0;
  secs.forEach((sec, i) => {
    out.push(...lines.slice(at, sec.start), links[i]);
    at = sec.end;
  });
  out.push(...lines.slice(at));
  const kept = out.join("\n");
  await lumen.document.setText(kept);
  await lumen.notifications.show(`Split into ${secs.length} notes. · פוצל ל-${secs.length} פתקים.`, "success");
}

await lumen.commands.register({ id: "extract", label: "Extract selection to a new note", hint: "Leaves a [[link]] in its place · העברת הבחירה לפתק חדש" }, extract);
await lumen.commands.register({ id: "split", label: "Split note by headings", hint: "Each ## section becomes a note · פיצול פתק לפי כותרות" }, split);
