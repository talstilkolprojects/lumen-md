// Tag manager — a Lumen plugin (plan W4.32; the Tag Wrangler idea, written
// from scratch). Lists every #tag of the vault (inline and front-matter
// `tags:`) with how many notes use it, Hebrew tags included, and renames a
// tag in every note at once — nested tags (#course/math) move with their
// parent. Code, links and URLs are left alone.

/** Characters a tag may contain (letters of any script, digits, _ - /). */
const TAG = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

function frontMatter(text) {
  if (!text.startsWith("---\n")) return { fm: "", body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { fm: "", body: text };
  const close = text.indexOf("\n", end + 4);
  const cut = close < 0 ? text.length : close + 1;
  return { fm: text.slice(0, cut), body: text.slice(cut) };
}

/** Body text outside code fences and inline code: [start, end) ranges. */
function proseRanges(body) {
  const out = [];
  let fence = null;
  let pos = 0;
  for (const line of body.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    } else if (!fence) {
      let last = 0;
      for (const m of line.matchAll(/(`+)[^`]*?\1/g)) {
        out.push([pos + last, pos + m.index]);
        last = m.index + m[0].length;
      }
      out.push([pos + last, pos + line.length]);
    }
    pos += line.length + 1;
  }
  return out;
}

/** Tags of the front matter's `tags:` (list or inline array or a single value). */
function fmTags(fm) {
  const out = [];
  const inline = /^tags:[ \t]*\[(.*)\][ \t]*$/m.exec(fm);
  if (inline) for (const t of inline[1].split(",")) out.push(t.trim().replace(/^["']|["']$/g, "").replace(/^#/, ""));
  const single = /^tags:[ \t]*([^\s[].*)$/m.exec(fm);
  if (single) for (const t of single[1].split(/[,\s]+/)) out.push(t.replace(/^["']|["']$/g, "").replace(/^#/, ""));
  const block = /^tags:\s*\n((?:\s+-\s+.*\n?)+)/m.exec(fm);
  if (block) for (const l of block[1].split("\n")) if (l.trim()) out.push(l.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "").replace(/^#/, ""));
  return out.filter(Boolean);
}

function tagsOf(text) {
  const { fm, body } = frontMatter(text);
  const set = new Set(fmTags(fm));
  for (const [a, b] of proseRanges(body)) {
    const seg = body.slice(a, b);
    for (const m of seg.matchAll(TAG)) {
      // Not the fragment of a link or URL (…/page#section, [[Note#Heading]]).
      if (/\]\(|https?:\/\/\S*$|\[\[[^\]]*$/.test(seg.slice(0, m.index + m[1].length))) continue;
      set.add(m[2]);
    }
  }
  return set;
}

/** Rename `from` (and `from/…`) to `to` in one note; returns the new text. */
function renameIn(text, from, to) {
  const { fm, body } = frontMatter(text);
  const swap = (t) => (t === from ? to : t.startsWith(`${from}/`) ? to + t.slice(from.length) : t);
  const fm2 = fm.replace(/^(tags:[ \t]*)(\[.*\]|[^\s[].*)$/m, (all, k, v) => k + v.replace(/[^\s,[\]"'#]+/g, (t) => swap(t))).replace(/^tags:\s*\n((?:\s+-\s+.*\n?)+)/m, (all) => all.replace(/^(\s+-\s+["']?#?)([^"'\n]+)/gm, (l, p, t) => p + swap(t.trim())));
  let out = "";
  let last = 0;
  for (const [a, b] of proseRanges(body)) {
    out += body.slice(last, a);
    const seg = body.slice(a, b);
    out += seg.replace(TAG, (all, pre, t, off) => (/\]\(|https?:\/\/\S*$|\[\[[^\]]*$/.test(seg.slice(0, off + pre.length)) ? all : `${pre}#${swap(t)}`));
    last = b;
  }
  return fm2 + out + body.slice(last);
}

async function notes(dir = "", depth = 0) {
  const out = [];
  for (const e of await lumen.vault.list(dir)) {
    if (e.kind === "dir" && depth < 8) out.push(...(await notes(e.path, depth + 1)));
    else if (e.kind === "file" && /\.md$/i.test(e.name)) out.push(e.path);
  }
  return out;
}

const state = { counts: [], selected: "" };

async function scan() {
  const counts = new Map();
  for (const p of await notes()) for (const t of tagsOf(await lumen.vault.read(p))) counts.set(t, (counts.get(t) ?? 0) + 1);
  state.counts = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function render() {
  await lumen.panel.render({
    type: "box",
    gap: 6,
    children: [
      { type: "heading", level: 2, text: `${state.counts.length} tags · ${state.counts.length} תגיות` },
      state.counts.length
        ? { type: "select", id: "tag", value: state.selected, options: [{ value: "", label: "Choose a tag to rename · בחרו תגית לשינוי שם" }, ...state.counts.map(([t, n]) => ({ value: t, label: `#${t} (${n})` }))] }
        : { type: "text", text: "No tags in the vault yet. · אין עדיין תגיות בכספת." },
      { type: "box", direction: "row", gap: 6, children: [{ type: "input", id: "to", placeholder: "New name · שם חדש" }, { type: "button", id: "rename", label: "Rename · שינוי שם", primary: true, disabled: !state.selected }] },
      { type: "list", items: state.counts.slice(0, 200).map(([t, n]) => [{ type: "text", text: `#${t} — ${n}` }]) },
    ],
  });
}

let newName = "";
lumen.on("ui:panel", async (e) => {
  if (e.id === "tag" && e.kind === "change") {
    state.selected = String(e.value ?? "");
    return render();
  }
  if (e.id === "to" && e.kind === "change") {
    newName = String(e.value ?? "").trim().replace(/^#/, "");
    return;
  }
  if (e.id !== "rename" || e.kind !== "click" || !state.selected) return;
  if (!/^[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*$/u.test(newName)) {
    await lumen.notifications.show("A tag is letters, digits, _ - and /, with at least one letter. · תגית היא אותיות, ספרות, _ - ו-/, עם אות אחת לפחות.", "error");
    return;
  }
  let changed = 0;
  for (const p of await notes()) {
    const text = await lumen.vault.read(p);
    const next = renameIn(text, state.selected, newName);
    if (next !== text) {
      await lumen.vault.write(p, next);
      changed++;
    }
  }
  await lumen.notifications.show(`#${state.selected} → #${newName} in ${changed} notes. · שונה ב-${changed} פתקים.`, "success");
  state.selected = "";
  await scan();
  await render();
});

await lumen.commands.register({ id: "show", label: "Tags: list and rename", hint: "Every #tag of the vault · ניהול תגיות" }, async () => {
  await lumen.panel.open({ title: "Tags · תגיות" });
  await scan();
  await render();
});
