// __PLUGIN_TITLE__ — a Lumen plugin. It runs in Lumen's QuickJS sandbox:
// no network, no DOM, no storage of its own — only the `lumen` API, and
// only the parts its manifest asks for (lumen-plugin.json → capabilities).
// Edit and save: with `npm run dev` connected, Lumen reloads it at once.

function count(text) {
  const words = text.match(/[\p{L}\p{N}'’"״׳-]+/gu) ?? [];
  return { words: words.length, chars: [...text].length };
}

async function show() {
  const c = count(await lumen.document.getText());
  await lumen.panel.open({ title: "__PLUGIN_TITLE__" });
  await lumen.panel.render({
    type: "box",
    children: [
      { type: "heading", level: 2, text: await lumen.document.getFileName() },
      { type: "text", text: `${c.words} words · ${c.chars} characters` },
      { type: "button", id: "refresh", label: "Refresh", primary: true },
    ],
  });
}

lumen.on("ui:panel", async (e) => {
  if (e.id === "refresh") await show();
});

await lumen.commands.register({ id: "show", label: "__PLUGIN_TITLE__", hint: "Count the words of this note" }, show);
