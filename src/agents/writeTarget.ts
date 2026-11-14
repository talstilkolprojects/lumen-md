/**
 * Which paths an agent may change (reviews 21 D3, 24, 30): one rule, used
 * by the write tools (tools/define.ts `safeWriteTarget`) and by
 * `staging.stageChange` itself, so every agent-made change is covered —
 * the runtime's tools, the organizer, the MCP inbox. Dependency-free.
 */

/** Files that steer other agents (Claude Code, Codex, Copilot, Cursor …): an agent of Lumen never writes them. */
export const AGENT_CONTROL_FILES = /^(claude|claude\.local|agents|agents\.override|gemini|copilot-instructions)\.md$|^\.(cursorrules|windsurfrules|mcp\.json)$/i;

/** Latin look-alikes (Cyrillic, Greek) folded to Latin before matching a name. */
const CONFUSABLES: Record<string, string> = {
  "\u0410": "A", "\u0412": "B", "\u0421": "C", "\u0415": "E", "\u041D": "H", "\u0406": "I", "\u0408": "J", "\u041A": "K", "\u041C": "M", "\u041E": "O", "\u0420": "P", "\u0405": "S", "\u0422": "T", "\u0425": "X", "\u0423": "Y",
  "\u0430": "a", "\u0441": "c", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0455": "s", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0458": "j",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0397": "H", "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03A1": "P", "\u03A4": "T", "\u03A7": "X", "\u03BF": "o",
};

/** A path segment as a file system (and a person) would read it: NFKC, no invisible characters, look-alikes folded, no trailing dots or spaces. */
export function canonicalSegment(seg: string): string {
  return seg
    .normalize("NFKC")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/[\u0370-\u03FF\u0400-\u04FF]/g, (c) => CONFUSABLES[c] ?? c)
    .replace(/[. ]+$/, "");
}

/**
 * Why an agent may not change `path`, or null when it may. `path` is a
 * vault path with `/` separators. Refused: absolute paths and `..`;
 * Windows stream syntax (`:$`, `::`, a trailing `:`), drive prefixes and
 * 8.3 short names (`~1`); dot folders (`.lumen/`, `.claude/`, `.git/`) and
 * agent control files — each segment compared in its canonical form, and
 * by its part before a `:` too, so `CLAUDE.md:stream` is CLAUDE.md
 * (review 30). An ordinary `:` or `~` in a note name is fine.
 */
export function writeTargetProblem(path: string): string | null {
  if (/^([a-zA-Z]:)?[\\/]/.test(path)) return `agents write only inside the vault, not to ${path}`;
  const parts = path.replace(/\\/g, "/").split("/");
  if (!path || parts.some((seg) => seg === "..")) return `invalid vault path: ${path}`;
  const last = parts.length - 1;
  for (let i = 0; i <= last; i++) {
    const raw = parts[i]!;
    if (raw === "" || raw === ".") continue;
    if (/:\$|::|:$|^[a-zA-Z]:|~\d/.test(raw)) return `agents do not write stream, drive or short names (${path})`;
    for (const seg of [canonicalSegment(raw), canonicalSegment(raw.split(":")[0]!)]) {
      if (!seg || seg.startsWith(".")) return `agents do not write under dot folders (${path}): they hold Lumen's skills and permissions and other tools' settings`;
      if (i === last && AGENT_CONTROL_FILES.test(seg)) return `agents do not write ${path}: it steers other agents`;
    }
  }
  return null;
}
