/**
 * Split an .mbox (plan W5.18) into its messages: each starts at a line
 * "From " at the start of the file or after a newline (mboxo / mboxrd as
 * Gmail's Takeout and Thunderbird write them); ">From " quoting inside a
 * message is undone (mboxrd: one ">" less on ">…>From " lines). Works on the
 * bytes, so a 5,000-message mailbox is one pass.
 */

const NL = 0x0a;
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

function startsFrom(b: Uint8Array, i: number): boolean {
  for (let k = 0; k < 5; k++) if (b[i + k] !== FROM[k]) return false;
  return true;
}

/** Undo mboxrd quoting: a line ">From ", ">>From ", … loses one ">". */
function unquote(msg: Uint8Array): Uint8Array {
  let quoted = false;
  for (let i = 0; i < msg.length - 5; i++) {
    if ((i === 0 || msg[i - 1] === NL) && msg[i] === 0x3e) {
      let j = i;
      while (msg[j] === 0x3e) j++;
      if (startsFrom(msg, j)) {
        quoted = true;
        break;
      }
    }
  }
  if (!quoted) return msg;
  const out: number[] = [];
  for (let i = 0; i < msg.length; i++) {
    if ((i === 0 || msg[i - 1] === NL) && msg[i] === 0x3e) {
      let j = i;
      while (msg[j] === 0x3e) j++;
      if (startsFrom(msg, j)) continue; // drop one ">"
    }
    out.push(msg[i]);
  }
  return new Uint8Array(out);
}

/** The messages of an mbox, each without its "From " separator line. */
export function splitMbox(b: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  if (startsFrom(b, 0)) starts.push(0);
  for (let i = b.indexOf(NL); i >= 0 && i < b.length - 5; i = b.indexOf(NL, i + 1)) {
    if (startsFrom(b, i + 1)) starts.push(i + 1);
  }
  const out: Uint8Array[] = [];
  for (let k = 0; k < starts.length; k++) {
    const lineEnd = b.indexOf(NL, starts[k]);
    if (lineEnd < 0) break;
    const end = k + 1 < starts.length ? starts[k + 1] : b.length;
    const msg = b.subarray(lineEnd + 1, end);
    if (msg.length) out.push(unquote(msg));
  }
  return out;
}

export const looksLikeMbox = (b: Uint8Array): boolean => startsFrom(b, 0) && b.indexOf(NL) > 0;
