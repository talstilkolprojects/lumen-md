/**
 * Reading a text file so that saving it writes the same bytes back (plan
 * W4.30, measured on real Obsidian vaults).
 *
 * `Blob.text()` decodes UTF-8 and drops a leading byte-order mark, so a note
 * saved by Windows Notepad lost its BOM on the first save. `readText` keeps
 * it; the editor hides it (see `splitTextEnvelope`) and puts it back.
 *
 * The editor (CodeMirror) splits lines on CRLF, CR and LF and joins them with
 * LF: one keystroke in a Windows-written note rewrote every line ending.
 * `splitTextEnvelope` records a note's line ending when the whole note uses
 * CRLF; `joinTextEnvelope` writes the edited text back with it. A note with
 * mixed endings is left to the editor (LF), as before.
 */

const BOM = "\uFEFF";

/** UTF-8 text of a file, the byte-order mark kept. */
export async function readText(blob: Blob): Promise<string> {
  // Stand-ins (tests, old engines) without arrayBuffer(): text() as before.
  if (typeof blob.arrayBuffer !== "function") return blob.text();
  return decodeUtf8(new Uint8Array(await blob.arrayBuffer()));
}

/** UTF-8 decode that keeps a leading BOM (`TextDecoder` drops it by default). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export interface TextEnvelope {
  /** The note started with U+FEFF. */
  bom: boolean;
  /** "\r\n" when every line break is CRLF; null otherwise (LF, mixed or a single line). */
  eol: "\r\n" | null;
}

/** What the editor shows (no BOM, LF line breaks) and how to write it back. */
export function splitTextEnvelope(text: string): { body: string; envelope: TextEnvelope } {
  const bom = text.startsWith(BOM);
  const rest = bom ? text.slice(1) : text;
  const crlf = (rest.match(/\r\n/g) ?? []).length;
  const breaks = (rest.match(/\r\n|\r|\n/g) ?? []).length;
  const eol = crlf > 0 && crlf === breaks ? "\r\n" : null;
  return { body: eol ? rest.replace(/\r\n/g, "\n") : rest, envelope: { bom, eol } };
}

/** The editor's text (LF) as the file is written: its BOM and CRLF line breaks back. */
export function joinTextEnvelope(body: string, envelope: TextEnvelope): string {
  const lines = envelope.eol ? body.replace(/\r\n|\r|\n/g, envelope.eol) : body;
  return envelope.bom ? BOM + lines : lines;
}
