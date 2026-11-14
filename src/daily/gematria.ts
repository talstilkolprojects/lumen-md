/** Hebrew numerals (plan 4.12), shared by the daily note and the Hebrew calendar. */

const LETTERS: Array<[number, string]> = [
  [400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"], [90, "צ"], [80, "פ"], [70, "ע"], [60, "ס"], [50, "נ"],
  [40, "מ"], [30, "ל"], [20, "כ"], [10, "י"], [9, "ט"], [8, "ח"], [7, "ז"], [6, "ו"], [5, "ה"], [4, "ד"], [3, "ג"], [2, "ב"], [1, "א"],
];

/**
 * A number in Hebrew numerals (1–999): 7 → ז׳, 16 → ט״ז, 787 → תשפ״ז. Only
 * the digits are ours; the calendar itself is Intl's.
 */
export function gematria(n: number): string {
  let s = "";
  let rest = n;
  while (rest > 0) {
    if (rest === 15 || rest === 16) {
      s += rest === 15 ? "טו" : "טז"; // never יה / יו
      break;
    }
    const [v, l] = LETTERS.find(([v]) => v <= rest)!;
    s += l;
    rest -= v;
  }
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}
