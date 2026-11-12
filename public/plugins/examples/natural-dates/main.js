// Natural dates — a Lumen plugin (plan W4.32; the Natural Language Dates
// idea, written from scratch, with Hebrew). Select "tomorrow", "next
// Friday", "in 3 days", "מחר", "יום שישי הבא", "בעוד שבועיים" or a date
// like 12/11/2026 (day first, as in Israel) and run "Date from words": the
// words become [[2026-11-13]] (a link to that day's note) or plain
// 2026-11-13, a setting. No Intl in the sandbox: the arithmetic is here.

const DAY = 86400000;
const EN_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const HE_DAYS = [["ראשון", "א"], ["שני", "ב"], ["שלישי", "ג"], ["רביעי", "ד"], ["חמישי", "ה"], ["שישי", "ו"], ["שבת", "ש"]];
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלושה: 3, שלוש: 3, ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5, שישה: 6, שש: 6, שבעה: 7, שבע: 7, עשרה: 10, עשר: 10 };

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

function count(word) {
  if (/^\d+$/.test(word)) return Number(word);
  return NUM_WORDS[word] ?? null;
}

/** The day `text` names, relative to `today` (UTC midnight, ms); null when it names none. */
function parse(text, today) {
  const s = text.trim().toLowerCase().replace(/[.,!?]+$/, "").replace(/\s+/g, " ");
  const dow = new Date(today).getUTCDay();
  const fixed = { today: 0, היום: 0, tomorrow: 1, מחר: 1, מחרתיים: 2, yesterday: -1, אתמול: -1, שלשום: -2, "day after tomorrow": 2, "day before yesterday": -2 };
  if (s in fixed) return today + fixed[s] * DAY;
  // Dates: 2026-11-13, 13/11/2026, 13.11.26, 13/11 (day first).
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : new Date(today).getUTCFullYear();
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
  }
  // in N days/weeks/months, N days from now; בעוד N ימים/שבועות/חודשים, בעוד שבוע/שבועיים/חודש.
  m = /^(?:in )?(\w+) (day|days|week|weeks|month|months)(?: from now)?$/.exec(s) ?? /^in (\w+) (day|days|week|weeks|month|months)$/.exec(s);
  const add = (n, unit) => {
    if (unit.startsWith("day") || unit.startsWith("יו") || unit.startsWith("ימ")) return today + n * DAY;
    if (unit.startsWith("week") || unit.startsWith("שבוע")) return today + 7 * n * DAY;
    const d = new Date(today);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate()));
  };
  if (m && count(m[1]) !== null) return add(count(m[1]), m[2]);
  m = /^(\w+) (day|days|week|weeks|month|months) ago$/.exec(s);
  if (m && count(m[1]) !== null) return add(-count(m[1]), m[2]);
  m = /^בעוד (?:(\S+) )?(יום|ימים|יומיים|שבוע|שבועות|שבועיים|חודש|חודשים|חודשיים)$/.exec(s);
  if (m) {
    const dual = { יומיים: ["יום", 2], שבועיים: ["שבוע", 2], חודשיים: ["חודש", 2] }[m[2]];
    if (dual && !m[1]) return add(dual[1], dual[0]);
    const n = m[1] ? count(m[1]) : 1;
    if (n !== null && !dual) return add(n, m[2]);
  }
  m = /^לפני (?:(\S+) )?(יום|ימים|יומיים|שבוע|שבועות|שבועיים)$/.exec(s);
  if (m) {
    const dual = { יומיים: ["יום", 2], שבועיים: ["שבוע", 2] }[m[2]];
    if (dual && !m[1]) return add(-dual[1], dual[0]);
    const n = m[1] ? count(m[1]) : 1;
    if (n !== null && !dual) return add(-n, m[2]);
  }
  // Weekdays: "friday" / "next friday" (the coming one), "last friday"; "יום שישי", "שישי הבא", "ביום שישי", "שישי שעבר".
  const target = (name) => {
    const en = EN_DAYS.indexOf(name);
    if (en >= 0) return en;
    const he = HE_DAYS.findIndex(([full, letter]) => name === full || name === `יום ${full}` || name === `ביום ${full}` || name === `ב${full}` || name === `יום ${letter}׳` || name === `יום ${letter}'`);
    return he >= 0 ? he : -1;
  };
  m = /^(?:(next|this|coming|last) )?(\w+)$/.exec(s);
  if (m && target(m[2]) >= 0) {
    const t = target(m[2]);
    if (m[1] === "last") return today - (((dow - t + 7) % 7) || 7) * DAY;
    return today + (((t - dow + 7) % 7) || 7) * DAY;
  }
  m = /^(.+?)(?: (הבא|הקרוב|שעבר|הקודם))?$/.exec(s);
  if (m && target(m[1]) >= 0) {
    const t = target(m[1]);
    if (m[2] === "שעבר" || m[2] === "הקודם") return today - (((dow - t + 7) % 7) || 7) * DAY;
    return today + (((t - dow + 7) % 7) || 7) * DAY;
  }
  return null;
}

function todayUtc(payload) {
  if (payload && typeof payload.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.today)) return Date.parse(`${payload.today}T00:00:00Z`);
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

async function format(iso) {
  const s = await lumen.settings.get();
  return s.links === false ? iso : `[[${iso}]]`;
}

await lumen.commands.register({ id: "convert", label: "Date from words", hint: "“next Friday”, “מחר” → [[2026-11-13]] · תאריך ממילים" }, async (payload) => {
  const sel = await lumen.document.getSelection();
  const text = sel && sel.text ? sel.text : "";
  const t = text ? parse(text, todayUtc(payload)) : null;
  if (t === null) return lumen.notifications.show(text ? `“${text.trim()}” is not a date I know. · „${text.trim()}” אינו תאריך מוכר.` : "Select words like “tomorrow” or “מחר” first. · קודם מסמנים מילים כמו „מחר”.", "info");
  await lumen.document.replaceSelection(await format(isoOf(t)));
});

await lumen.commands.register({ id: "today", label: "Insert today’s date", hint: "As [[YYYY-MM-DD]] · הוספת התאריך של היום" }, async (payload) => {
  await lumen.document.insertText(await format(isoOf(todayUtc(payload))));
});
