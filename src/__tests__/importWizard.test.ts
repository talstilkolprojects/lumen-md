/**
 * Plan W1.26 — the import wizard, on one golden export per source:
 * 0 attachments lost, ≥ 98 % of internal links resolved, Hebrew names and
 * dates kept, a Notion database as a .base with the same columns, and an
 * undo that puts the vault back exactly as it was (same hash).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { collectVault } from "../storage/exportAll";
import { writeWorkspaceFile, workspaceHasEntry } from "../storage/workspace";
import { listTrash } from "../storage/trash";
import { addToImport, commitImport, lastImport, prepareImport, undoImport } from "../storage/import/commit";
import { parseBase, propertyLabel, runBase, basesFileFromText } from "../views/bases/base";
import { splitFrontmatter } from "../storage/import/frontmatter";
import { reportMarkdown } from "../storage/import/report";
import type { ImportSourceId } from "../storage/import/types";
import { NOTION_COLUMNS, LOGSEQ_UUID, appleNotesExport, bearExport, evernoteExport, keepExport, logseqGraph, notionExport, obsidianVault, onenoteExport } from "./fixtures/import/exports";

beforeEach(() => {
  installFakeOpfs();
  localStorage.clear();
});

async function vaultHash(): Promise<string> {
  const files = await collectVault();
  const parts = files.map((f) => `${f.path}\0${[...f.data].join(",")}`).join("\n");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const fm = (text: string | undefined) => splitFrontmatter(text ?? "").props;

const GOLDEN: [ImportSourceId, () => Map<string, Uint8Array> | Promise<Map<string, Uint8Array>>, string][] = [
  ["obsidian", obsidianVault, "כספת"],
  ["notion", notionExport, "Export-7a1b.zip"],
  ["evernote", evernoteExport, "מחברת עבודה.enex"],
  ["bear", bearExport, "Bear Notes.bearbk"],
  ["appleNotes", appleNotesExport, "Notes"],
  ["keep", keepExport, "takeout-20240201.zip"],
  ["logseq", logseqGraph, "graph"],
  ["onenote", onenoteExport, "סיכום.mht"],
];

describe("golden exports: one per source", () => {
  for (const [source, make, name] of GOLDEN) {
    it(`${source}: detected, 0 attachments lost, ≥ 98% of internal links resolved`, async () => {
      const prep = await prepareImport(await make(), name, null);
      expect(prep.detected).toBe(source);
      expect(prep.vault.notes.size).toBeGreaterThan(0);
      expect(prep.vault.sourceAttachments).toBeGreaterThan(0);
      expect(prep.vault.attachments.size).toBe(prep.vault.sourceAttachments);
      expect(prep.links.total).toBeGreaterThan(0);
      expect(prep.links.resolved / prep.links.total, JSON.stringify(prep.links.unresolved)).toBeGreaterThanOrEqual(0.98);
      const { report } = await commitImport(prep);
      expect(report.attachmentsLost).toBe(0);
      expect(report.folder.startsWith("Imported/")).toBe(true);
    });
  }
});

describe("what each source becomes", () => {
  it("Obsidian: the vault as it is, Hebrew names kept, .obsidian left out with its reason", async () => {
    const prep = await prepareImport(obsidianVault(), "כספת", null);
    expect([...prep.vault.notes.keys()].sort()).toEqual(["בית.md", "ספרים.base", "פרויקטים/תוכנית.md"]);
    expect([...prep.vault.attachments.keys()]).toEqual(["attachments/תמונה.png"]);
    expect(prep.vault.skipped.map((s) => s.reason)).toEqual(["appFolder", "appFolder"]);
    expect(prep.folder).toBe("Imported/כספת");
  });

  it("Notion: ids gone, links follow, the database is a .base with the same columns and every row", async () => {
    const prep = await prepareImport(await notionExport(), "Export-7a1b.zip", null);
    const notes = prep.vault.notes;
    expect([...notes.keys()].sort()).toEqual(["בית.md", "בית/Project Alpha.md", "ספרים.base", "ספרים/Dune.md", "ספרים/Empty row.md", "ספרים/שלום עולם.md"]);
    expect([...prep.vault.attachments.keys()].sort()).toEqual(["בית/diagram.png", "ספרים/Dune/cover.jpg"]);
    expect(prep.vault.skipped).toEqual([{ path: `ספרים ${"03".repeat(16)}.csv`, reason: "duplicate" }]);
    expect(notes.get("בית.md")).toContain("[ספרים](ספרים.base)");
    expect(notes.get("בית/Project Alpha.md")).toContain("[home](../בית.md)");
    expect(notes.get("בית/Project Alpha.md")).toContain("(<../ספרים/שלום עולם.md>)");

    // Row pages: cells are typed properties, the repeated "Author: …" lines are gone.
    const row = notes.get("ספרים/שלום עולם.md")!;
    expect(fm(row)).toEqual({ Author: "עמוס עוז", Pages: 320, Read: true, Published: "2024-01-31", Tags: "novel, hebrew" });
    expect(splitFrontmatter(row).body).toBe("# שלום עולם\n\nתקציר קצר.\n");
    expect(fm(notes.get("ספרים/Empty row.md"))).toEqual({ Read: false });

    // The .base: same columns, in order; it lists the three rows.
    const parsed = parseBase(notes.get("ספרים.base")!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const view = parsed.base.views[0];
    expect(view.order.map((id) => propertyLabel(parsed.base, id))).toEqual(NOTION_COLUMNS);
    const files = [...notes].map(([p, text]) => basesFileFromText(`${prep.folder}/${p}`, text));
    const result = runBase(parsed.base, files);
    expect(result.errors).toEqual([]);
    expect(result.columns.map((c) => c.label)).toEqual(NOTION_COLUMNS);
    expect(result.rows.map((r) => r.file.basename).sort()).toEqual(["Dune", "Empty row", "שלום עולם"]);
  });

  it("Evernote: a notebook folder, ENML to Markdown, media by MD5, dates and tags as properties", async () => {
    const prep = await prepareImport(evernoteExport(), "מחברת עבודה.enex", null);
    const note = prep.vault.notes.get("מחברת עבודה/פגישת צוות & תכנון.md")!;
    expect(fm(note)).toEqual({ created: "2024-01-31T10:15:00Z", updated: "2024-01-31T11:30:00Z", tags: ["עבודה", "weekly-sync"], source: "https://example.com/meeting", author: "טל" });
    expect(note).toContain("- [x] לסגור גרסה");
    expect(note).toContain("- [ ] לכתוב מסמך");
    expect(note).toContain("![לוח.png](<_resources/פגישת צוות & תכנון/לוח.png>)");
    expect(note).toContain("[[רשימה]]");
    const list = prep.vault.notes.get("מחברת עבודה/רשימה.md")!;
    // An attachment the note never shows is still listed, never dropped.
    expect(list).toContain("[דוח (סופי).pdf](<_resources/רשימה/דוח (סופי).pdf>)");
    expect(list).not.toContain("AAAA");
    expect(prep.vault.warnings).toEqual([{ path: "מחברת עבודה/רשימה.md", reason: "encryptedPart" }]);
  });

  it("Bear: TextBundles become notes with their assets, Bear syntax becomes standard, trash left out", async () => {
    const prep = await prepareImport(await bearExport(), "Bear Notes.bearbk", null);
    expect([...prep.vault.notes.keys()].sort()).toEqual(["Ideas.md", "רשימת קניות.md"]);
    const shop = prep.vault.notes.get("רשימת קניות.md")!;
    expect(fm(shop)).toEqual({ created: "2024-01-10T08:00:00Z", updated: "2024-01-12T09:30:00Z", pinned: true });
    expect(shop).toContain("![](<assets/רשימת קניות/photo 1.png>)");
    const ideas = prep.vault.notes.get("Ideas.md")!;
    expect(ideas).toContain("==important== see [[רשימת קניות]] and `::code::`");
    expect(ideas).toContain("#multi-word-tag and #simple");
    expect(ideas).toContain("[sketch](assets/Ideas/sketch.pdf)");
    expect(prep.vault.skipped).toEqual([{ path: "Old.textbundle", reason: "trashed" }]);
  });

  it("Apple Notes: HTML pages to notes, inline images extracted, links between pages follow", async () => {
    const prep = await prepareImport(appleNotesExport(), "Notes", null);
    const cake = prep.vault.notes.get("iCloud/מתכון.md")!;
    expect(fm(cake)).toEqual({ created: "2023-12-01T10:00:00Z", updated: "2023-12-05T18:20:00Z", source: "Apple Notes" });
    expect(cake).toContain("![עוגה](attachments/מתכון-1.png)");
    expect(cake).toContain("[קניות](Shopping.md)");
    const shop = prep.vault.notes.get("iCloud/Shopping.md")!;
    expect(shop).toContain("- [x] Milk");
    expect(shop).toContain("- [ ] Eggs");
    expect(shop).toContain("[המתכון](מתכון.md)");
    expect([...prep.vault.attachments.keys()].sort()).toEqual(["iCloud/attachments/list.png", "iCloud/attachments/מתכון-1.png"]);
  });

  it("Google Keep: checklists, labels as tags, .jpeg found as .jpg, archive folder, trash and copies left out", async () => {
    const prep = await prepareImport(await keepExport(), "takeout-20240201.zip", null);
    expect([...prep.vault.notes.keys()].sort()).toEqual(["Archive/רעיון לסטארטאפ.md", "Groceries.md"]);
    const g = prep.vault.notes.get("Groceries.md")!;
    expect(fm(g)).toEqual({ created: "2024-01-31T10:00:00Z", updated: "2024-01-31T11:00:00Z", tags: ["קניות"], color: "yellow", pinned: true });
    expect(g).toContain("- [x] חלב\n- [ ] Bread");
    expect(g).toContain("![photo.jpg](attachments/photo.jpg)");
    expect([...prep.vault.attachments.keys()].sort()).toEqual(["attachments/photo.jpg", "attachments/recording.3gp"]);
    const reasons = Object.fromEntries(prep.vault.skipped.map((s) => [s.path.split("/").pop(), s.reason]));
    expect(reasons).toEqual({ "archive_browser.html": "unsupported", "Labels.txt": "appFolder", "Deleted.json": "trashed", "Groceries.html": "duplicate", "old.png": "trashed" });
  });

  it("Logseq: properties, tasks, block refs and embeds, journals by date, namespaces as folders", async () => {
    const prep = await prepareImport(logseqGraph(), "graph", null);
    expect([...prep.vault.notes.keys()].sort()).toEqual(["journals/2024-01-31.md", "pages/Project/Alpha.md", "pages/meeting notes.md", "pages/פגישה שבועית.md"]);
    const alpha = prep.vault.notes.get("pages/Project/Alpha.md")!;
    expect(fm(alpha)).toEqual({ tags: ["work", "urgent"], status: "active" });
    expect(alpha).toContain(`- [ ] write the spec ^${LOGSEQ_UUID}`);
    expect(alpha).toContain("- [x] kickoff");
    expect(alpha).toContain("[[meeting notes|Meeting Notes]]");
    expect(alpha).toContain("![board](../../assets/board.png)");
    expect(alpha).toContain("[[2024-01-31|Jan 31st, 2024]]");
    const day = prep.vault.notes.get("journals/2024-01-31.md")!;
    expect(day).toContain(`[[Project/Alpha]]: [[Project/Alpha#^${LOGSEQ_UUID}]]`);
    expect(day).toContain(`![[Project/Alpha#^${LOGSEQ_UUID}]]`);
    const meet = prep.vault.notes.get("pages/meeting notes.md")!;
    expect(meet).toContain("[[פגישה שבועית|פגישה שבועית]]");
    expect(meet).toContain("![[Project/Alpha]]");
    expect(meet).not.toContain("collapsed::");
    expect(prep.vault.skipped.map((s) => s.reason)).toEqual(["appFolder", "appFolder"]);
  });

  it("OneNote: a .mht page with its images and files, Hebrew decoded from quoted-printable, .one explained", async () => {
    const prep = await prepareImport(onenoteExport(), "סיכום.mht", null);
    const page = prep.vault.notes.get("סיכום.md")!;
    expect(page).toContain("# סיכום פרויקט");
    expect(page).toContain("- לוח זמנים");
    expect(page).toContain("![תרשים](attachments/image001.png)");
    expect(page).toContain("[notes.pdf](attachments/notes.pdf)");
    expect(prep.vault.skipped).toEqual([{ path: "Notebook.one", reason: "unsupported", detail: ".mht" }]);
    expect(prep.vault.warnings).toEqual([{ path: "סיכום.md", reason: "noDates" }]);
  });
});

describe("into a new folder, undone in one click", () => {
  async function seed() {
    await writeWorkspaceFile("שלי.md", "# my note");
    await writeWorkspaceFile("Imported/כספת/old.md", "an earlier import");
  }

  it("never writes over anything: the next free folder", async () => {
    await seed();
    const prep = await prepareImport(obsidianVault(), "כספת", "obsidian");
    expect(prep.folder).toBe("Imported/כספת 2");
    await commitImport(prep);
    expect(await workspaceHasEntry("Imported/כספת/old.md")).toBe(true);
    expect(await workspaceHasEntry("Imported/כספת 2/בית.md")).toBe(true);
  });

  it("undo puts the vault back to the same hash (and removes Imported/ when the import made it)", async () => {
    await writeWorkspaceFile("שלי.md", "# my note");
    const before = await vaultHash();
    const { undo } = await commitImport(await prepareImport(await notionExport(), "Export-7a1b.zip", null));
    expect(await vaultHash()).not.toBe(before);
    expect(lastImport()?.folder).toBe(undo.folder);
    expect(await undoImport(lastImport()!)).toBe("removed");
    expect(await vaultHash()).toBe(before);
    expect(await workspaceHasEntry("Imported")).toBe(false);
    expect(lastImport()).toBeNull();
  });

  it("undo keeps an Imported/ that was there before, and takes back a saved report too", async () => {
    await seed();
    const before = await vaultHash();
    const { report, undo } = await commitImport(await prepareImport(await keepExport(), "takeout-20240201.zip", null));
    const path = await addToImport(undo, "Import report.md", reportMarkdown(report));
    expect(path).toBe(`${undo.folder}/Import report.md`);
    expect(await undoImport(lastImport()!)).toBe("removed");
    expect(await vaultHash()).toBe(before);
  });

  it("files changed after the import: undo moves the folder to the trash instead of deleting it", async () => {
    await seed();
    const before = await vaultHash();
    const { undo } = await commitImport(await prepareImport(tinyExport(), "x", "lumen"));
    await writeWorkspaceFile(`${undo.folder}/a.md`, "edited after the import");
    expect(await undoImport(undo)).toBe("trashed");
    expect(await vaultHash()).toBe(before);
    expect((await listTrash()).map((i) => i.originalPath)).toEqual([undo.folder]);
  });

  it("a second undo has nothing left to take back", async () => {
    const { undo } = await commitImport(await prepareImport(tinyExport(), "x", "lumen"));
    expect(await undoImport(undo)).toBe("removed");
    expect(await undoImport(undo)).toBe("gone");
  });
});

describe("the report", () => {
  it("names what came in, what did not and why, in the active language's words", async () => {
    const { report } = await commitImport(await prepareImport(await keepExport(), "takeout-20240201.zip", null));
    const md = reportMarkdown(report);
    expect(md).toContain("# Import report");
    expect(md).toContain("2 notes, 2 attachments and 0 databases");
    expect(md).toContain("`Keep/Deleted.json` — in the app's trash");
    expect(md).toContain("`Keep/Groceries.html` — another copy of a file that is imported");
  });
});

function tinyExport(): Map<string, Uint8Array> {
  return new Map([["a.md", new TextEncoder().encode("# a\n")]]);
}
