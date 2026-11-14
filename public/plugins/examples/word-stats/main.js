// Word stats — an example Lumen plugin (plan 11.2). Runs in the QuickJS
// sandbox: no network, no DOM; only the `lumen` API its manifest's granted
// capabilities open.

const NIKUD = /[֑-ׇ]/g;

function stats(text, wpm) {
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(NIKUD, "");
  const words = clean.match(/[\p{L}\p{N}'’"״׳-]+/gu) ?? [];
  const freq = new Map();
  for (const w of words) {
    const k = w.toLowerCase();
    if (k.length < 3) continue;
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return { words: words.length, chars: [...text].length, minutes: Math.max(1, Math.round(words.length / wpm)), top };
}

async function show() {
  const settings = await lumen.settings.get();
  const wpm = typeof settings.wpm === "number" ? settings.wpm : 200;
  const name = await lumen.document.getFileName();
  const s = stats(await lumen.document.getText(), wpm);
  await lumen.panel.open({ title: "Word stats" });
  await lumen.panel.render({
    type: "box",
    children: [
      { type: "heading", level: 2, text: name },
      { type: "list", items: [
        [{ type: "text", text: `Words: ${s.words}` }],
        [{ type: "text", text: `Characters: ${s.chars}` }],
        [{ type: "text", text: `Reading time: ${s.minutes} min at ${wpm} words/min` }],
      ] },
      { type: "heading", level: 3, text: "Most frequent" },
      { type: "list", ordered: true, items: s.top.map(([w, n]) => [{ type: "text", text: `${w} — ${n}` }]) },
      { type: "divider" },
      { type: "box", direction: "row", children: [
        { type: "select", id: "wpm", value: String(wpm), options: [150, 200, 250, 300].map((n) => ({ value: String(n), label: `${n} words/min` })) },
        { type: "button", id: "refresh", label: "Refresh", primary: true },
      ] },
    ],
  });
}

lumen.on("ui:panel", async (e) => {
  if (e.id === "refresh") await show();
  if (e.id === "wpm" && e.kind === "change") {
    await lumen.settings.set({ wpm: Number(e.value) });
    await show();
  }
});

await lumen.commands.register({ id: "show", label: "Word stats", hint: "Words, reading time, frequent words" }, show);
