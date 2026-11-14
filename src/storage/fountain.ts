/**
 * Fountain screenplays → Markdown (split out of fileFormats.ts, plan W4.11).
 * fileFormats.ts re-exports fountainToMarkdown.
 */
/**
 * Fountain (screenwriting plain-text, fountain.io) → Markdown.
 *
 * Pragmatic subset of the spec, mapped for readability rather than
 * re-exportable fidelity:
 *   title page key/values → `# Title` + a bold metadata block
 *   scene headings (INT./EXT./EST./I/E or forced `.`) → `## ` headings
 *   sections `#`/`##`/… → headings one level down (the title keeps `#`)
 *   synopses `= …` → italic line · page breaks `===` → `---`
 *   transitions (ALL-CAPS ending `TO:` or forced `>`) → italic line
 *   centered `>text<` → bold line
 *   CHARACTER cues → bold, parentheticals italic, dialogue as blockquote
 *   lyrics `~…` → italic · boneyard comments and `[[notes]]` stripped
 */
export function fountainToMarkdown(text: string): string {
  // Strip boneyard comments and notes first (both may span lines).
  let src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\[\[[\s\S]*?\]\]/g, "");
  src = src.replace(/\r\n?/g, "\n");

  const out: string[] = [];
  const lines = src.split("\n");
  let i = 0;

  // ── Title page: leading `Key: value` pairs up to the first blank line ──
  if (/^[A-Za-z][A-Za-z ]*:/.test(lines[0] ?? "")) {
    const meta: Array<[string, string]> = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const m = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(lines[i]);
      if (m) {
        meta.push([m[1].trim(), m[2].trim()]);
      } else if (meta.length && /^\s+\S/.test(lines[i])) {
        // indented continuation line (multi-line values, e.g. Contact:)
        meta[meta.length - 1][1] = (meta[meta.length - 1][1] + " " + lines[i].trim()).trim();
      }
      i++;
    }
    const title = meta.find(([k]) => k.toLowerCase() === "title");
    if (title?.[1]) out.push(`# ${title[1]}`, "");
    const rest = meta.filter(([k, v]) => k.toLowerCase() !== "title" && v);
    if (rest.length) {
      for (const [k, v] of rest) out.push(`**${k}:** ${v}  `);
      out.push("");
    }
  }

  const isSceneHeading = (ln: string): boolean =>
    /^(INT|EXT|EST|INT\.?\/EXT|I\/E)[. ]/i.test(ln.trim());
  const isTransition = (ln: string): boolean => /^[A-Z0-9 .']+TO:$/.test(ln.trim());
  const isCharacterCue = (ln: string): boolean => {
    const t = ln.trim();
    if (!t || t.length > 60) return false;
    // ALL-CAPS (digits/space/./'/- allowed, optional trailing parenthetical
    // extension like (V.O.), optional dual-dialogue caret)
    const m = /^(@)?([A-Z0-9 .'\-]+)(\s*\([^)]*\))?\s*\^?$/.exec(t);
    if (!m) return false;
    if (m[1]) return true; // forced @CUE
    const name = m[2].trim();
    return (
      /[A-Z]/.test(name) &&
      name === name.toUpperCase() &&
      !isSceneHeading(t) &&
      !isTransition(t)
    );
  };

  while (i < lines.length) {
    const ln = lines[i].trim();

    if (ln === "") {
      if (out[out.length - 1] !== "") out.push("");
      i++;
      continue;
    }
    if (/^={3,}$/.test(ln)) {
      out.push("---", "");
      i++;
      continue;
    }
    if (/^#{1,6}\s/.test(ln)) {
      const m = /^(#{1,6})\s*(.*)$/.exec(ln)!;
      out.push(`${"#".repeat(Math.min(m[1].length + 1, 6))} ${m[2].trim()}`, "");
      i++;
      continue;
    }
    if (/^=\s/.test(ln)) {
      out.push(`*${ln.slice(1).trim()}*`, "");
      i++;
      continue;
    }
    if (/^>.*<$/.test(ln)) {
      out.push(`**${ln.slice(1, -1).trim()}**`, "");
      i++;
      continue;
    }
    if (ln.startsWith(">") || isTransition(ln)) {
      out.push(`*${ln.replace(/^>\s*/, "").trim()}*`, "");
      i++;
      continue;
    }
    // Forced scene heading `.HEADING` (but not "..." ellipsis action)
    if (ln.startsWith(".") && !ln.startsWith("..")) {
      out.push(`## ${ln.slice(1).trim()}`, "");
      i++;
      continue;
    }
    if (isSceneHeading(ln)) {
      out.push(`## ${ln}`, "");
      i++;
      continue;
    }
    if (ln.startsWith("~")) {
      out.push(`*${ln.slice(1).trim()}*`, "");
      i++;
      continue;
    }
    // Character cue: must be followed by a non-blank dialogue line.
    if (isCharacterCue(ln) && (lines[i + 1] ?? "").trim() !== "") {
      out.push(`**${ln.replace(/^@/, "").replace(/\s*\^$/, "")}**`);
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        const d = lines[i].trim();
        if (/^\(.*\)$/.test(d)) out.push(`*${d}*`);
        else out.push(`> ${d.replace(/^!/, "")}`);
        i++;
      }
      out.push("");
      continue;
    }
    // Action (default); `!` forces action — strip the marker.
    out.push(ln.replace(/^!/, ""));
    i++;
  }

  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}
