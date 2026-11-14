/**
 * File and folder names for imported notes: Hebrew (and every other
 * script) kept as written, only what a file system refuses replaced.
 */

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
// Bidi controls and the zero-width no-break space that tools paste into
// titles: invisible in a name, but they make two names that look the same
// differ (and break links typed by hand).
const INVISIBLE = /[\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX = 120;

/** One path segment: NFC, no characters a file system refuses, at most 120 characters. */
export function safeName(name: string, fallback = "Untitled"): string {
  let s = name.normalize("NFC").replace(INVISIBLE, "").replace(ILLEGAL, "-").replace(/\s+/g, " ").trim();
  // A leading dot hides the file (and puts it among the app folders); trailing dots and spaces vanish on Windows.
  s = s.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (RESERVED.test(s)) s = `${s}-`;
  const chars = [...s];
  if (chars.length > MAX) s = chars.slice(0, MAX).join("").trim();
  return s || fallback;
}

/** Every segment of `path` made safe (the extension of the last one kept). */
export function safePath(path: string): string {
  const parts = path.split("/").filter((p) => p && p !== ".");
  return parts
    .map((p, i) => {
      if (i < parts.length - 1) return safeName(p, "folder");
      const ext = p.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? "";
      return safeName(p.slice(0, p.length - ext.length)) + ext.toLowerCase();
    })
    .join("/");
}

/** `path`, or `stem 2.ext`, `stem 3.ext`, … — the first that `taken` does not hold (case-insensitive, as macOS and Windows compare). The result is added to `taken`. */
export function claimPath(taken: Set<string>, path: string): string {
  const key = (p: string) => p.normalize("NFC").toLowerCase();
  let out = path;
  if (taken.has(key(out))) {
    const ext = path.match(/\.[^./]+$/)?.[0] ?? "";
    const stem = path.slice(0, path.length - ext.length);
    let n = 2;
    while (taken.has(key(`${stem} ${n}${ext}`))) n++;
    out = `${stem} ${n}${ext}`;
  }
  taken.add(key(out));
  return out;
}

export const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
export const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const stemOf = (p: string) => baseOf(p).replace(/\.[^.]+$/, "");

/** `rel` resolved against folder `fromDir` (`..` and `.` folded). */
export function resolveRel(fromDir: string, rel: string): string {
  const out: string[] = [];
  for (const p of [...(fromDir ? fromDir.split("/") : []), ...rel.split("/")]) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** The relative path from folder `fromDir` to `to`. */
export function relativeTo(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** A Markdown link destination: `<…>` when it has spaces or parentheses, so any name works. */
export function mdDest(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, "")}>` : path;
}

/** `![](dest)` for an image, `[name](dest)` for anything else. */
export function mdEmbed(path: string, fromDir: string, name = baseOf(path)): string {
  const dest = mdDest(relativeTo(fromDir, path));
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i.test(path) ? `![${name.replace(/[[\]]/g, "")}](${dest})` : `[${name.replace(/[[\]]/g, "")}](${dest})`;
}
