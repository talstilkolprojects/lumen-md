// Sort lines — a Lumen plugin (plan W4.32; the Sort & Permute Lines idea,
// written from scratch, list-aware like Outliner). Sorts the selected lines
// A→Z or Z→A, by length, reverses them, or removes duplicates. A list item
// keeps its indented sub-items with it. Hebrew sorts by its letters: niqqud
// is ignored and final letters (ך ם ן ף ץ) sort as their regular forms;
// numbers sort by value ("2" before "10"). No Intl in the sandbox, so the
// comparison is here.

function key(s) {
  return s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ך/g, "כ")
    .replace(/ם/g, "מ")
    .replace(/ן/g, "נ")
    .replace(/ף/g, "פ")
    .replace(/ץ/g, "צ")
    .toLowerCase()
    .trim();
}

/** Natural compare: runs of digits by value, the rest by code point. */
function compare(a, b) {
  const ka = key(a).match(/\d+|\D+/g) ?? [];
  const kb = key(b).match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) return Number(x) - Number(y) || x.length - y.length;
    return x < y ? -1 : 1;
  }
  return ka.length - kb.length;
}

const indent = (l) => /^\s*/.exec(l)[0].replace(/\t/g, "    ").length;

/** Group lines: each top-level line with the more-indented lines under it. */
function groups(lines) {
  const base = Math.min(...lines.filter((l) => l.trim()).map(indent));
  const out = [];
  for (const l of lines) {
    if (out.length && (indent(l) > base || !l.trim()) && out[out.length - 1].length) out[out.length - 1].push(l);
    else out.push([l]);
  }
  // Trailing blank lines of a group stay at the end of the whole block.
  const tail = [];
  const last = out[out.length - 1];
  while (last && last.length > 1 && !last[last.length - 1].trim()) tail.unshift(last.pop());
  return { out, tail };
}

const OPS = {
  "sort-asc": (g) => g.sort((a, b) => compare(a[0], b[0])),
  "sort-desc": (g) => g.sort((a, b) => compare(b[0], a[0])),
  "sort-length": (g) => g.sort((a, b) => key(a[0]).length - key(b[0]).length || compare(a[0], b[0])),
  reverse: (g) => g.reverse(),
  unique: (g) => {
    const seen = new Set();
    return g.filter((x) => {
      const k = x.map(key).join("\n");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
};

async function apply(op) {
  const sel = await lumen.document.getSelection();
  const text = await lumen.document.getText();
  if (!sel || sel.from === sel.to) return lumen.notifications.show("Select the lines to sort first. · קודם מסמנים את השורות.", "info");
  // Whole lines: from the start of the first selected line to the end of the last.
  const from = text.lastIndexOf("\n", sel.from - 1) + 1;
  let to = sel.to;
  if (to > from && text[to - 1] === "\n") to--;
  const nl = text.indexOf("\n", to);
  to = nl < 0 ? text.length : nl;
  const lines = text.slice(from, to).split("\n");
  const { out, tail } = groups(lines);
  const sorted = OPS[op](out).flat().concat(tail);
  const removed = lines.length - sorted.length;
  await lumen.document.setText(text.slice(0, from) + sorted.join("\n") + text.slice(to));
  if (op === "unique") await lumen.notifications.show(`Removed ${removed} duplicate lines. · הוסרו ${removed} שורות כפולות.`, removed ? "success" : "info");
}

await lumen.commands.register({ id: "sort-asc", label: "Sort lines A→Z", hint: "The selected lines; sub-items move with their item · מיון שורות א→ת" }, () => apply("sort-asc"));
await lumen.commands.register({ id: "sort-desc", label: "Sort lines Z→A", hint: "The selected lines · מיון שורות ת→א" }, () => apply("sort-desc"));
await lumen.commands.register({ id: "sort-length", label: "Sort lines by length", hint: "Shortest first · מיון לפי אורך" }, () => apply("sort-length"));
await lumen.commands.register({ id: "reverse", label: "Reverse lines", hint: "Last line first · היפוך סדר השורות" }, () => apply("reverse"));
await lumen.commands.register({ id: "unique", label: "Remove duplicate lines", hint: "Keeps the first of each · הסרת שורות כפולות" }, () => apply("unique"));
