/**
 * The vault the 20 golden `.base` files (plan W1.11) run over. The same
 * notes, with these times, are what to open in Obsidian 1.14 to compare
 * (see docs/src/content/docs/workspace/obsidian-bases.md, "Golden set").
 */
export interface VaultEntry {
  path: string;
  /** null: an attachment (no text). */
  text: string | null;
  mtime: string;
  size?: number;
}

const note = (fm: string, body = "") => `---\n${fm.trim()}\n---\n${body}`;

export const VAULT: VaultEntry[] = [
  { path: "Books/Dune.md", mtime: "2026-02-01T10:00:00Z", text: note("type: book\nauthor: Frank Herbert\nrating: 5\npages: 412\nprice: 9.99\nstatus: read\ntags: [book, scifi]\npublished: 1965-08-01", "Desert planet. See [[Foundation]].\n") },
  { path: "Books/Foundation.md", mtime: "2026-03-01T10:00:00Z", text: note("type: book\nauthor: Isaac Asimov\nrating: 4\npages: 255\nprice: 7.5\nstatus: read\ntags:\n  - book\n  - scifi/classic\npublished: 1951-06-01") },
  { path: "Books/Neuromancer.md", mtime: "2026-04-01T10:00:00Z", text: note("type: book\nauthor: William Gibson\nrating: 3\npages: 271\nprice: 12\nstatus: reading\ntags: [book, scifi/cyberpunk]\npublished: 1984-07-01") },
  { path: "Books/Emma.md", mtime: "2026-05-01T10:00:00Z", text: note("type: book\nauthor: Jane Austen\nrating: 4\npages: 474\nprice: 5\nstatus: to-read\ntags: [book, classic]\npublished: 1815-12-23") },
  { path: "Books/הנסיך הקטן.md", mtime: "2026-06-01T10:00:00Z", text: note("type: book\nauthor: אנטואן דה סנט-אכזופרי\nrating: 5\npages: 96\nprice: 39\nstatus: read\ntags: [book, ספר]\npublished: 1943-04-06\nlang: he", "ספר על [[Haifa]]? לא, על כוכב קטן.\n") },
  { path: "Movies/Arrival.md", mtime: "2026-07-01T10:00:00Z", text: note('type: movie\ndirector: Denis Villeneuve\nrating: 5\nyear: 2016\nwatched: true\ntags: [movie]\nrelated: "[[Dune]]"') },
  { path: "Movies/Blade Runner.md", mtime: "2026-07-02T10:00:00Z", text: note("type: movie\ndirector: Ridley Scott\nrating: 4\nyear: 1982\nwatched: false\ntags: [movie, scifi/cyberpunk]", "Based on a novel; compare [[Neuromancer]].\n") },
  { path: "Projects/Website.md", mtime: "2026-11-01T10:00:00Z", text: note("status: active\ndue: 2026-11-20\npriority: 2\nowner: Noa\ntags: [project]") },
  { path: "Projects/Garden.md", mtime: "2026-10-01T10:00:00Z", text: note("status: done\ndue: 2026-10-01\npriority: 3\ntags: [project, home]") },
  { path: "Projects/Archive/Old site.md", mtime: "2025-03-01T10:00:00Z", text: note("status: done\ndue: 2025-03-01\npriority: 1\ntags: [project]") },
  { path: "Places/Tel Aviv.md", mtime: "2025-05-01T10:00:00Z", text: note('location: "32.0853, 34.7818"\nvisited: 2025-05-01\ntags: [place]') },
  { path: "Places/Haifa.md", mtime: "2025-06-01T10:00:00Z", text: note("location: [32.794, 34.9896]\ntags: [place]") },
  { path: "Daily/2026-11-09.md", mtime: "2026-11-09T20:00:00Z", text: "Read [[Dune]] today. #journal\n\n![[map.png]]\n\n```\n#not-a-tag [[Not a link]]\n```\n" },
  { path: "Daily/2026-11-10.md", mtime: "2026-11-10T08:00:00Z", text: note("mood: 4", "#journal worked on [[Website]]\n") },
  { path: "Index.md", mtime: "2026-01-01T10:00:00Z", text: "# Index\n\n- [[Dune]]\n- [[Foundation]]\n- [Arrival](Movies/Arrival.md)\n- [site](https://example.com)\n" },
  { path: "map.png", mtime: "2026-01-01T10:00:00Z", text: null, size: 2048 },
];

/** "Now" for the golden set: today() is 2026-11-10. */
export const GOLDEN_NOW = new Date("2026-11-10T12:00:00Z");
