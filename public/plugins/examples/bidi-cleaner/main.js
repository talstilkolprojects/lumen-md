// Bidi cleaner — an example Lumen plugin (plan W3.10). Text copied from
// Word, WhatsApp or web pages into a Hebrew or Arabic note often carries
// invisible bidi controls; they make the cursor jump and break search and
// links. This removes them from the selection (or the whole note when
// nothing is selected). Inside code (fences and `inline`) nothing changes.

// LRM RLM ALM, LRE RLE PDF LRO RLO, LRI RLI FSI PDI, ZWSP, BOM / ZWNBSP.
// ZWJ / ZWNJ are kept: some scripts and emoji need them.
const MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/g;

function clean(text) {
  let removed = 0;
  const strip = (s) => s.replace(MARKS, () => (removed++, ""));
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    // Keep inline code spans as they are.
    out.push(line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : strip(part))).join(""));
  }
  return { text: out.join("\n"), removed };
}

async function run() {
  const sel = await lumen.document.getSelection();
  const whole = !sel || sel.from === sel.to;
  const r = clean(whole ? await lumen.document.getText() : sel.text);
  if (!r.removed) {
    await lumen.notifications.show("No invisible direction marks found.", "info");
    return;
  }
  if (whole) await lumen.document.setText(r.text);
  else await lumen.document.replaceSelection(r.text);
  await lumen.notifications.show(`Removed ${r.removed} invisible ${r.removed === 1 ? "mark" : "marks"}.`, "success");
}

await lumen.commands.register({ id: "clean", label: "Remove invisible direction marks", hint: "RLM, LRM, isolates, zero-width spaces" }, run);
