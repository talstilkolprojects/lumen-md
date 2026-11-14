// Markdown tidy — a Lumen plugin (plan W4.32; the Linter idea, written from
// scratch). One command fixes the common slips of a note and says how many
// it fixed: trailing spaces (a two-space line break is kept), runs of blank
// lines, a blank line around headings, a space after the heading's #, one
// bullet style, and a final newline. Front matter and code blocks are
// never touched. Each rule can be turned off in the plugin's settings.

const RULES = ["trailing-spaces", "blank-lines", "heading-space", "heading-blank-lines", "bullets", "final-newline"];

/** Split into segments: { code: boolean, lines: string[] } (front matter and fenced code are `code`). */
function segments(text) {
  const lines = text.split("\n");
  const out = [];
  let cur = null;
  const push = (code, line) => {
    if (!cur || cur.code !== code) {
      cur = { code, lines: [] };
      out.push(cur);
    }
    cur.lines.push(line);
  };
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (; i <= end; i++) push(true, lines[i]);
    }
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (f && !fence) {
      fence = f[1];
      push(true, lines[i]);
      continue;
    }
    if (fence) {
      push(true, lines[i]);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s{0,3}[`~]+\s*$/.test(lines[i])) fence = null;
      continue;
    }
    push(false, lines[i]);
  }
  return out;
}

function lintText(text, enabled) {
  const on = (r) => enabled[r] !== false;
  let fixes = 0;
  const count = (before, after) => {
    if (before !== after) fixes++;
    return after;
  };
  const segs = segments(text.replace(/\r\n/g, "\n"));
  // The first bullet used in the note sets the style.
  let bullet = null;
  for (const s of segs) {
    if (s.code) continue;
    for (const l of s.lines) {
      const m = /^\s*([-*+])\s+\S/.exec(l);
      if (m && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
        bullet = bullet ?? m[1];
      }
    }
  }
  for (const s of segs) {
    if (s.code) continue;
    s.lines = s.lines.map((l) => {
      let x = l;
      if (on("trailing-spaces")) x = count(x, /\S {2}$/.test(x) && !/\S {3,}$/.test(x) ? x : x.replace(/[ \t]+$/, ""));
      if (on("heading-space")) x = count(x, x.replace(/^(\s{0,3}#{1,6})(?=[^\s#])/, "$1 "));
      if (on("bullets") && bullet) x = count(x, x.replace(/^(\s*)([-*+])(\s+)(?=\S)/, (all, sp, b, gap) => (/^\s*([-*_])(\s*\1){2,}\s*$/.test(x) ? all : `${sp}${bullet}${gap}`)));
      return x;
    });
  }
  // Blank lines: around headings, and no more than one in a row (outside code).
  let lines = [];
  for (const s of segs) for (const l of s.lines) lines.push({ l, code: s.code });
  if (on("heading-blank-lines")) {
    const out = [];
    lines.forEach((x, i) => {
      const isHeading = !x.code && /^\s{0,3}#{1,6}\s/.test(x.l);
      if (isHeading && out.length && out[out.length - 1].l.trim() !== "") {
        out.push({ l: "", code: false });
        fixes++;
      }
      out.push(x);
      const next = lines[i + 1];
      if (isHeading && next && next.l.trim() !== "") {
        out.push({ l: "", code: false });
        fixes++;
      }
    });
    lines = out;
  }
  if (on("blank-lines")) {
    const out = [];
    for (const x of lines) {
      if (!x.code && x.l.trim() === "" && out.length && !out[out.length - 1].code && out[out.length - 1].l.trim() === "") {
        fixes++;
        continue;
      }
      out.push(x);
    }
    lines = out;
  }
  let result = lines.map((x) => x.l).join("\n");
  if (on("final-newline") && result.length) {
    const fixed = result.replace(/\n*$/, "\n");
    if (fixed !== result) fixes++;
    result = fixed;
  }
  return { text: result, fixes };
}

await lumen.commands.register({ id: "lint", label: "Tidy Markdown", hint: "Spaces, blank lines, headings, bullets · סידור Markdown" }, async () => {
  const s = await lumen.settings.get();
  const enabled = {};
  for (const r of RULES) enabled[r] = !(Array.isArray(s.off) && s.off.includes(r));
  const before = await lumen.document.getText();
  const { text, fixes } = lintText(before, enabled);
  if (text !== before) await lumen.document.setText(text);
  await lumen.notifications.show(fixes ? `Fixed ${fixes} ${fixes === 1 ? "thing" : "things"}. · תוקנו ${fixes}.` : "Nothing to fix. · אין מה לתקן.", fixes ? "success" : "info");
});
