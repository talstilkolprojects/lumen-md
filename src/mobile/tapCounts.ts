/**
 * Ten common phone actions, counted in taps (plan W1.25 acceptance: Lumen
 * needs no more taps than Obsidian Mobile for any of them).
 *
 * Every Lumen step names the control or gesture it uses, so
 * `src/__tests__/mobileNative.test.ts` checks the count against the real
 * default toolbar and gesture rules, and `e2e/mobile-native.spec.ts` performs
 * the sequences on iPhone 14 and Pixel 7 profiles.
 *
 * Counting rules, for both apps: start in an open note with the keyboard up
 * (or, for the reading-view row, with the note open for reading); a tap, a
 * swipe and picking from a list or the system photo picker are one each;
 * typing a note's name is not counted.
 *
 * The Obsidian Mobile column is counted by hand against its default mobile
 * toolbar and gestures and has **not** been measured on a device here:
 * `obsidianVerified: false` until someone does (the PR lists it as owed).
 */

export type Step =
  | `toolbar:${string}`
  | "swipe:start-edge"
  | "swipe:end-edge"
  | "tap:text"
  | "pick:suggestion"
  | "pick:photo"
  | "select:word";

export interface TapRow {
  id: string;
  en: string;
  he: string;
  lumen: Step[];
  obsidian: number;
  obsidianHow: string;
  obsidianVerified: boolean;
}

export const TAP_ROWS: readonly TapRow[] = [
  { id: "task", en: "Turn a line into a task", he: "להפוך שורה למשימה", lumen: ["toolbar:task"], obsidian: 1, obsidianHow: "toolbar: toggle checklist", obsidianVerified: false },
  { id: "indent", en: "Indent a list item", he: "להזיח פריט ברשימה", lumen: ["toolbar:indent"], obsidian: 1, obsidianHow: "toolbar: indent", obsidianVerified: false },
  { id: "outdent", en: "Outdent a list item", he: "לבטל הזחה של פריט", lumen: ["toolbar:outdent"], obsidian: 1, obsidianHow: "toolbar: unindent", obsidianVerified: false },
  { id: "wikilink", en: "Link to another note", he: "לקשר לפתק אחר", lumen: ["toolbar:wikilink", "pick:suggestion"], obsidian: 2, obsidianHow: "toolbar: internal link, pick from the list", obsidianVerified: false },
  { id: "image", en: "Insert a photo", he: "להוסיף תמונה", lumen: ["toolbar:image", "pick:photo"], obsidian: 2, obsidianHow: "toolbar: attach file, pick the photo", obsidianVerified: false },
  { id: "heading", en: "Make the line a heading", he: "להפוך שורה לכותרת", lumen: ["toolbar:heading"], obsidian: 2, obsidianHow: "no heading button by default: pull down for the command palette, pick “Toggle heading”", obsidianVerified: false },
  { id: "bold", en: "Bold a word", he: "להדגיש מילה", lumen: ["select:word", "toolbar:bold"], obsidian: 2, obsidianHow: "double-tap the word, toolbar: bold", obsidianVerified: false },
  { id: "files", en: "Open the file list", he: "לפתוח את רשימת הקבצים", lumen: ["swipe:start-edge"], obsidian: 1, obsidianHow: "swipe in from the left edge", obsidianVerified: false },
  { id: "outline", en: "Open the outline", he: "לפתוח את תוכן העניינים", lumen: ["swipe:end-edge"], obsidian: 2, obsidianHow: "swipe in from the right edge, tap the outline tab", obsidianVerified: false },
  { id: "editHere", en: "Start editing a long note at a paragraph", he: "להתחיל לערוך פתק ארוך בפסקה מסוימת", lumen: ["tap:text"], obsidian: 2, obsidianHow: "tap the edit/read toggle, tap the paragraph", obsidianVerified: false },
];

export const lumenTaps = (row: TapRow): number => row.lumen.length;
