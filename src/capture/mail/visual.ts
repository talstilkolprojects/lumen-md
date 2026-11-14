/**
 * Visual-order Hebrew (plan W5.18). MIME's "ISO-8859-8" means *visual*
 * order: each line is stored as it looks on a left-to-right screen, so the
 * Hebrew reads backwards (RFC 1555; its successor draft keeps receivers
 * decoding it, and names "ISO-8859-8-I" for logical order). Old Israeli
 * clients and webmail sent it. Many others put logical text under the same
 * label, so the label alone can't be trusted: final letters (ך ם ן ף ץ)
 * end a word in logical text and *start* one in visual text, which tells
 * the two apart.
 */

const HEB = /[֐-׿יִ-ﭏ]/;
const FINAL = /[ךםןףץ]/;
const LETTER = /[א-ת]/;
/** כ מ נ פ צ: the letters that have a final form, in their plain form. */
const NON_FINAL = /[כמנפצ]/;

/**
 * True when the Hebrew in `text` reads backwards (visual order). Signals:
 * a final letter (ך ם ן ף ץ) starting a word, or a plain כ מ נ פ צ ending
 * one, happen only when the text is reversed; a final letter ending a word
 * is normal logical text.
 */
export function looksVisual(text: string): boolean {
  let visual = 0;
  let logical = 0;
  for (const word of text.split(/[^\u05d0-\u05ea]+/)) {
    if (word.length < 2) continue;
    if (FINAL.test(word[0])) visual++;
    if (NON_FINAL.test(word[word.length - 1])) visual++;
    if (FINAL.test(word[word.length - 1])) logical++;
  }
  return visual > logical;
}

const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };

/**
 * One visual line → logical order: reverse the line, then put runs that are
 * not Hebrew (Latin words, numbers, URLs) back in their own order, and
 * mirror brackets. Lines with no Hebrew are left as they are.
 */
export function visualLineToLogical(line: string): string {
  if (!HEB.test(line)) return line;
  const rev = [...line].reverse().map((c) => MIRROR[c] ?? c);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    // A run of left-to-right characters, with the spaces and neutrals inside it, keeps its order.
    let lead = 0;
    while (lead < run.length && /\s/.test(run[lead])) lead++;
    let tail = run.length;
    while (tail > lead && /\s/.test(run[tail - 1])) tail--;
    const core = run.slice(lead, tail).reverse().map((c) => MIRROR[c] ?? c);
    out.push(...run.slice(0, lead), ...core, ...run.slice(tail));
    run = [];
  };
  for (const c of rev) {
    if (LETTER.test(c) || HEB.test(c)) {
      if (run.length) flush();
      out.push(c);
    } else if (/[A-Za-z0-9]/.test(c) || (run.length && !/[\s.,!?:;"'״׳()[\]{}<>-]/.test(c))) {
      run.push(c);
    } else if (run.length && /[\s.,:/@-]/.test(c)) {
      run.push(c);
    } else {
      if (run.length) flush();
      out.push(c);
    }
  }
  if (run.length) flush();
  return out.join("");
}

/** A whole text: each line turned around when the text reads visually. */
export function visualToLogical(text: string): string {
  return text
    .split("\n")
    .map((l) => visualLineToLogical(l.replace(/\r$/, "")))
    .join("\n");
}
