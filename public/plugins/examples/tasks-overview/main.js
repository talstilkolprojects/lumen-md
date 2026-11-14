// Tasks overview — an example Lumen plugin (plan W3.10). Walks the vault
// (read-only), finds Markdown tasks outside code fences and lists the
// open ones per note in the side panel.

const MAX_NOTES = 500;

async function notes(dir = "", out = [], depth = 0) {
  if (depth > 8 || out.length >= MAX_NOTES) return out;
  for (const e of await lumen.vault.list(dir)) {
    if (out.length >= MAX_NOTES) break;
    if (e.kind === "dir") await notes(e.path, out, depth + 1);
    else if (/\.(md|markdown)$/i.test(e.name)) out.push(e.path);
  }
  return out;
}

function tasks(text) {
  const open = [];
  let done = 0;
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === " ") open.push(m[2].trim());
    else done++;
  }
  return { open, done };
}

async function show() {
  await lumen.panel.open({ title: "Tasks" });
  await lumen.panel.render({ type: "text", text: "Reading the vault…" });
  const groups = [];
  let open = 0, done = 0;
  for (const path of await notes()) {
    const t = tasks(await lumen.vault.read(path));
    open += t.open.length;
    done += t.done;
    if (t.open.length) groups.push({ path, open: t.open });
  }
  const target = (p) => p.replace(/\.(md|markdown)$/i, "");
  await lumen.panel.render({
    type: "box",
    children: [
      { type: "heading", level: 2, text: `${open} open · ${done} done` },
      ...groups.flatMap((g) => [
        { type: "paragraph", children: [{ type: "noteLink", target: target(g.path), label: target(g.path) }] },
        { type: "list", items: g.open.map((x) => [{ type: "text", text: x }]) },
      ]),
      { type: "divider" },
      { type: "button", id: "refresh", label: "Refresh", primary: true },
    ],
  });
}

lumen.on("ui:panel", async (e) => {
  if (e.id === "refresh") await show();
});

await lumen.commands.register({ id: "show", label: "Tasks overview", hint: "Open tasks from every note" }, show);
