// Hebrew date — an example Lumen plugin (plan W3.10). The sandbox has no
// Intl, so the calendar is computed here (the arithmetic of Reingold &
// Dershowitz, "Calendrical Calculations"); the test compares it with
// Node's ICU for every day of 1900–2100.

const EPOCH = -1373427; // R.D. of 1 Tishri AM 1
const DAY = 86400000;
const RD_1970 = 719163;

const isLeap = (y) => (7 * y + 1) % 19 < 7;

function elapsed(y) {
  const months = Math.floor((235 * y - 234) / 19);
  const parts = 12084 + 13753 * months;
  const days = 29 * months + Math.floor(parts / 25920);
  return (3 * (days + 1)) % 7 < 3 ? days + 1 : days;
}

function newYear(y) {
  const a = elapsed(y - 1), b = elapsed(y), c = elapsed(y + 1);
  return EPOCH + b + (c - b === 356 ? 2 : b - a === 382 ? 1 : 0);
}

/** Months from Tishri, with their lengths, for year y. */
function months(y) {
  const len = newYear(y + 1) - newYear(y);
  const list = [
    ["תשרי", 30],
    ["חשוון", len % 10 === 5 ? 30 : 29],
    ["כסלו", len % 10 === 3 ? 29 : 30],
    ["טבת", 29],
    ["שבט", 30],
  ];
  if (isLeap(y)) list.push(["אדר א׳", 30], ["אדר ב׳", 29]);
  else list.push(["אדר", 29]);
  list.push(["ניסן", 30], ["אייר", 29], ["סיוון", 30], ["תמוז", 29], ["אב", 30], ["אלול", 29]);
  return list;
}

/** A Gregorian y-m-d (UTC) → { year, month (name), day }. */
function toHebrew(gy, gm, gd) {
  const rd = Math.floor(Date.UTC(gy, gm - 1, gd) / DAY) + RD_1970;
  let y = Math.floor((rd - EPOCH) / 365.2468) + 1;
  while (newYear(y + 1) <= rd) y++;
  while (newYear(y) > rd) y--;
  let rest = rd - newYear(y);
  for (const [name, n] of months(y)) {
    if (rest < n) return { year: y, month: name, day: rest + 1 };
    rest -= n;
  }
  throw new Error("unreachable");
}

const ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const HUNDREDS = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];

/** 1–999 in Hebrew numerals, with geresh / gershayim (ט״ו, ט״ז). */
function gematria(n) {
  let s = HUNDREDS[Math.floor(n / 100)];
  const r = n % 100;
  s += r === 15 ? "טו" : r === 16 ? "טז" : TENS[Math.floor(r / 10)] + ONES[r % 10];
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}

function format(gy, gm, gd) {
  const h = toHebrew(gy, gm, gd);
  return `${gematria(h.day)} ב${h.month} ${gematria(h.year % 1000)}`;
}

function today() {
  const d = new Date();
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

lumen.on("render:hebrew-date", async ({ requestId, source }) => {
  const rows = [];
  for (const line of source.split("\n")) {
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(line);
    if (m) rows.push([{ type: "text", text: `${m[1]}-${m[2]}-${m[3]} — ${format(Number(m[1]), Number(m[2]), Number(m[3]))}` }]);
    else if (/^\s*today\s*$/i.test(line)) rows.push([{ type: "text", text: format(...today()) }]);
  }
  await lumen.renderer.result(requestId, rows.length ? { type: "list", items: rows } : { type: "text", text: "Write one date per line: 2026-11-10, or today." });
});

// The command's payload may carry { date: "YYYY-MM-DD" } (the tests use it); otherwise today.
await lumen.commands.register({ id: "insert", label: "Insert Hebrew date", hint: "Today, in the Hebrew calendar" }, async (payload) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payload?.date ?? "");
  await lumen.document.insertText(m ? format(Number(m[1]), Number(m[2]), Number(m[3])) : format(...today()));
});
await lumen.renderer.register("hebrew-date");
