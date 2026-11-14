// Callout cards — an example Lumen plugin (plan 11.2): a code-block
// renderer. The plugin answers with a UI tree, never HTML; ticks are kept
// in the plugin's own storage, keyed by the block's text.

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function inline(line) {
  // [[Note]] → a note link; the rest stays text.
  const out = [];
  let last = 0;
  for (const m of line.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    if (m.index > last) out.push({ type: "text", text: line.slice(last, m.index) });
    out.push({ type: "noteLink", target: m[1].trim(), label: (m[2] ?? m[1]).trim() });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ type: "text", text: line.slice(last) });
  return out;
}

async function render(source) {
  const lines = source.split("\n");
  const title = (lines.shift() ?? "").trim() || "Note";
  const key = hash(source);
  const ticked = (await lumen.storage.get(key)) ?? {};
  const body = [];
  let checklist = [];
  const flush = () => {
    if (checklist.length) body.push({ type: "box", gap: 2, children: checklist });
    checklist = [];
  };
  lines.forEach((line, i) => {
    const m = /^\s*- \[( |x)\] (.*)$/i.exec(line);
    if (m) {
      const id = `${key}.${i}`;
      checklist.push({ type: "checkbox", id, label: m[2], checked: ticked[i] ?? m[1].toLowerCase() === "x" });
      return;
    }
    flush();
    if (line.trim()) body.push({ type: "paragraph", children: inline(line) });
  });
  flush();
  return { type: "box", gap: 4, children: [{ type: "heading", level: 3, text: title }, ...body] };
}

lumen.on("render:callout", async ({ requestId, source }) => {
  await lumen.renderer.result(requestId, await render(source));
});

lumen.on("ui:block", async (e) => {
  if (e.kind !== "change") return;
  const [key, index] = e.id.split(".");
  const ticked = (await lumen.storage.get(key)) ?? {};
  ticked[index] = e.value === true;
  await lumen.storage.set(key, ticked);
});

await lumen.renderer.register("callout");
