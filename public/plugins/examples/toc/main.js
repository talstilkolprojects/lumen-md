// Table of contents — an example Lumen plugin (plan W3.10). Reads the
// headings of the open note (skipping code fences and front matter) and
// inserts a nested list of [[#Heading]] links at the cursor.

function headings(text, maxLevel) {
  const out = [];
  let fence = null;
  const lines = text.split("\n");
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m || m[1].length > maxLevel) continue;
    // Links and emphasis would break the [[#…]] target: keep their text.
    const title = m[2].replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
    if (title) out.push({ level: m[1].length, title });
  }
  return out;
}

function toc(list) {
  if (!list.length) return "";
  const top = Math.min(...list.map((h) => h.level));
  return list.map((h) => `${"  ".repeat(h.level - top)}- [[#${h.title.replace(/[|\]]/g, " ")}|${h.title}]]`).join("\n") + "\n";
}

async function insert() {
  const settings = await lumen.settings.get();
  const maxLevel = Number.isInteger(settings.maxLevel) ? settings.maxLevel : 3;
  const text = toc(headings(await lumen.document.getText(), maxLevel));
  if (text) await lumen.document.insertText(text);
}

await lumen.commands.register({ id: "insert", label: "Insert table of contents", hint: "Headings of this note as links" }, insert);
