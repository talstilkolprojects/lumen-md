// Calendar — a Lumen plugin (plan W4.32; the Calendar idea, written from
// scratch). A month view of the vault's daily notes (YYYY-MM-DD.md) in a
// side panel: days with a note link to it, the week starts on Sunday (or
// Monday, a setting), months move back and forth. No Intl in the sandbox,
// so the month grid is computed here.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const HE_DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Weeks of a month as rows of 7 cells (day number or null), the week starting on `weekStart` (0 Sunday, 1 Monday). */
function monthGrid(year, month, weekStart) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (first - weekStart + 7) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Daily notes found in the folder (and its direct sub-folders, like Daily/2026/): date → path. */
async function dailyNotes(folder) {
  const out = new Map();
  const scan = async (dir, depth) => {
    let entries = [];
    try {
      entries = await lumen.vault.list(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.kind === "dir" && depth < 2) await scan(e.path, depth + 1);
      const m = /^(\d{4}-\d{2}-\d{2})\.md$/i.exec(e.name);
      if (e.kind === "file" && m) out.set(m[1], e.path.replace(/\.md$/i, ""));
    }
  };
  await scan(folder, 0);
  return out;
}

const state = { year: 0, month: 0, today: "" };

async function render() {
  const s = await lumen.settings.get();
  const folder = typeof s.folder === "string" ? s.folder.replace(/^\/+|\/+$/g, "") : "";
  const weekStart = s.weekStart === 1 ? 1 : 0;
  const notes = await dailyNotes(folder);
  const header = (weekStart ? [...DAYS.slice(1), DAYS[0]] : DAYS).map((d, i) => `${d} ${(weekStart ? [...HE_DAYS.slice(1), HE_DAYS[0]] : HE_DAYS)[i]}`);
  const weeks = monthGrid(state.year, state.month, weekStart);
  let inMonth = 0;
  const rows = weeks.map((w) => ({
    type: "box",
    direction: "row",
    gap: 4,
    children: w.map((d) => {
      if (d === null) return { type: "text", text: "·" };
      const key = iso(state.year, state.month, d);
      const mark = key === state.today ? `[${d}]` : String(d);
      if (notes.has(key)) {
        inMonth++;
        return { type: "noteLink", target: notes.get(key), label: mark };
      }
      return { type: "text", text: mark };
    }),
  }));
  await lumen.panel.render({
    type: "box",
    gap: 6,
    children: [
      { type: "heading", level: 2, text: `${MONTHS[state.month]} ${state.year} · ${HE_MONTHS[state.month]}` },
      {
        type: "box",
        direction: "row",
        gap: 6,
        children: [
          { type: "button", id: "prev", label: "‹" },
          { type: "button", id: "today", label: "Today · היום" },
          { type: "button", id: "next", label: "›" },
        ],
      },
      { type: "text", text: header.join("  ") },
      ...rows,
      { type: "text", text: `${inMonth} daily notes this month · ${inMonth} פתקים יומיים החודש` },
      {
        type: "box",
        direction: "row",
        gap: 6,
        children: [{ type: "select", id: "weekStart", value: String(weekStart), options: [{ value: "0", label: "Week starts Sunday · השבוע מתחיל ביום ראשון" }, { value: "1", label: "Week starts Monday · השבוע מתחיל ביום שני" }] }],
      },
    ],
  });
}

function setToday(isoDate) {
  const d = isoDate ? new Date(`${isoDate}T12:00:00Z`) : new Date();
  state.today = isoDate || iso(d.getFullYear(), d.getMonth(), d.getDate());
  state.year = Number(state.today.slice(0, 4));
  state.month = Number(state.today.slice(5, 7)) - 1;
}

lumen.on("ui:panel", async (e) => {
  if (e.id === "prev" || e.id === "next") {
    const m = state.month + (e.id === "next" ? 1 : -1);
    state.year += Math.floor(m / 12);
    state.month = ((m % 12) + 12) % 12;
  } else if (e.id === "today") setToday(state.today);
  else if (e.id === "weekStart" && e.kind === "change") await lumen.settings.set({ ...(await lumen.settings.get()), weekStart: e.value === "1" ? 1 : 0 });
  else return;
  await render();
});

await lumen.commands.register({ id: "show", label: "Calendar of daily notes", hint: "Month view in a side panel · לוח שנה של פתקים יומיים" }, async (payload) => {
  setToday(payload && typeof payload.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.today) ? payload.today : "");
  await lumen.panel.open({ title: "Calendar · לוח שנה" });
  await render();
});
