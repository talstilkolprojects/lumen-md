// Templates — a Lumen plugin (plan W4.32; the Templater idea, written from
// scratch). Inserts a note from the vault's Templates folder at the cursor,
// filling {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{weekday}},
// {{hebrewWeekday}} and {{selection}}. Runs in the QuickJS sandbox: no
// network, no Intl — dates are formatted here.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HE_WEEKDAYS = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Format `d` with YYYY YY MMMM MM M DD D HH mm ss dddd (Moment-style tokens, the common subset). */
function formatDate(d, fmt) {
  const tokens = {
    YYYY: () => String(d.getFullYear()),
    YY: () => pad(d.getFullYear() % 100),
    MMMM: () => MONTHS[d.getMonth()],
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    HH: () => pad(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    dddd: () => WEEKDAYS[d.getDay()],
  };
  return fmt.replace(/YYYY|YY|MMMM|MM|M|DD|D|HH|mm|ss|dddd|\[([^\]]*)\]/g, (t, lit) => (lit !== undefined ? lit : tokens[t]()));
}

/** Fill a template's variables. Unknown {{names}} are left as written. */
function fill(template, ctx) {
  return template.replace(/\{\{\s*([A-Za-z]+)(?::([^}]*))?\s*\}\}/g, (all, name, arg) => {
    switch (name) {
      case "title":
        return ctx.title;
      case "date":
        return formatDate(ctx.now, arg ? arg.trim() : "YYYY-MM-DD");
      case "time":
        return formatDate(ctx.now, arg ? arg.trim() : "HH:mm");
      case "weekday":
        return WEEKDAYS[ctx.now.getDay()];
      case "hebrewWeekday":
        return HE_WEEKDAYS[ctx.now.getDay()];
      case "selection":
        return ctx.selection;
      default:
        return all;
    }
  });
}

/** Front matter of the template is kept only when the note has none yet. */
function withoutFrontMatter(text) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  return end < 0 ? text : text.slice(end + 4).replace(/^\r?\n/, "");
}

async function folder() {
  const s = await lumen.settings.get();
  return typeof s.folder === "string" && s.folder.trim() ? s.folder.trim().replace(/^\/+|\/+$/g, "") : "Templates";
}

async function listTemplates() {
  const dir = await folder();
  let entries = [];
  try {
    entries = await lumen.vault.list(dir);
  } catch {
    return { dir, files: [] };
  }
  const files = entries.filter((e) => e.kind === "file" && /\.md$/i.test(e.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { dir, files };
}

let pendingNow = null;
let shown = [];

async function insertTemplate(path) {
  const raw = await lumen.vault.read(path);
  const name = await lumen.document.getFileName();
  const doc = await lumen.document.getText();
  const sel = await lumen.document.getSelection();
  const now = pendingNow ? new Date(pendingNow) : new Date();
  const body = fill(doc.startsWith("---\n") ? withoutFrontMatter(raw) : raw, {
    title: String(name || "").replace(/^.*\//, "").replace(/\.md$/i, ""),
    now,
    selection: sel && sel.text ? sel.text : "",
  });
  if (sel && sel.text) await lumen.document.replaceSelection(body);
  else await lumen.document.insertText(body);
  await lumen.panel.close();
}

async function choose(payload) {
  pendingNow = payload && typeof payload.now === "string" ? payload.now : null;
  const { dir, files } = await listTemplates();
  if (files.length === 1) return insertTemplate(files[0].path);
  await lumen.panel.open({ title: "Templates · תבניות" });
  if (!files.length) {
    await lumen.panel.render({
      type: "box",
      children: [
        { type: "text", text: `No templates in “${dir}”. Put .md notes there, with {{date}}, {{title}}, {{selection}}…` },
        { type: "text", text: `אין תבניות בתיקייה „${dir}”. שימו שם פתקי .md עם {{date}}, {{title}}, {{selection}}…` },
      ],
    });
    return;
  }
  await lumen.panel.render({
    type: "box",
    gap: 6,
    children: [
      { type: "heading", level: 3, text: dir },
      ...files.map((f, i) => ({ type: "button", id: `t${i}`, label: f.name.replace(/\.md$/i, "") })),
    ],
  });
  shown = files;
}

lumen.on("ui:panel", async (e) => {
  const m = /^t(\d+)$/.exec(e.id);
  if (!m || e.kind !== "click" || !shown[Number(m[1])]) return;
  await insertTemplate(shown[Number(m[1])].path);
});

await lumen.commands.register({ id: "insert", label: "Insert template", hint: "From the Templates folder · הוספת תבנית" }, choose);
