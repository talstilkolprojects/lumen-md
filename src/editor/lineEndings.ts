/**
 * Line endings in the source editor (W1.2).
 *
 * CodeMirror splits a document on every common line break (`\n`, `\r\n`,
 * `\r`) and joins it back with `\n`, unless `EditorState.lineSeparator` says
 * otherwise. So without a separator a Windows file (CRLF) opened in the
 * source editor and saved came back with LF endings: every line changed.
 *
 * `lineSeparatorFor` picks the separator that writes the file back byte for
 * byte:
 * - only CRLF breaks: `\r\n`;
 * - only CR breaks (old Mac files): `\r`;
 * - anything else (LF only, no breaks, or mixed): `\n`. With `\n` as the
 *   separator a `\r` before or between lines stays in the text as a
 *   character (CodeMirror shows it as a special-character mark), so a file
 *   with mixed endings is still written back unchanged.
 *
 * No CodeMirror import here: the WYSIWYG editor's save uses it too.
 */
export type LineSeparator = "\n" | "\r\n" | "\r";

export function lineSeparatorFor(text: string): LineSeparator {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (crlf > 0 && lf === 0 && cr === 0) return "\r\n";
  if (cr > 0 && lf === 0 && crlf === 0) return "\r";
  return "\n";
}
