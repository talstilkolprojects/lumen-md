/**
 * Plan W11.P1 — what Lumen ports from Obsidian Importer 3.1.15 (MIT):
 * Google Keep's rich text, multi-line titles, annotations and timestamps,
 * tested on the importer's own public Keep notes (copied unchanged, with
 * their licence and hashes); and Notion's localized dates, with Hebrew
 * (he-IL) added. The attribution is checked too.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { convertKeep } from "../storage/import/keep";
import { splitFrontmatter } from "../storage/import/frontmatter";
import { notionDate, typeColumn } from "../storage/import/notion";
import { inferOrder, parseNotionDate } from "../storage/import/notionDates";

const DIR = "src/__tests__/fixtures/obsidian-importer";
const names = readdirSync(`${DIR}/keep`).filter((n) => n.endsWith(".json")).sort();
const takeout = () => new Map(names.map((n) => [`Takeout/Keep/${n}`, new Uint8Array(readFileSync(`${DIR}/keep/${n}`))] as [string, Uint8Array]));
const vault = convertKeep(takeout());
const note = (title: string) => {
  const hit = [...vault.notes.entries()].find(([p]) => p.split("/").pop() === `${title}.md`);
  if (!hit) throw new Error(`no note ${title}: ${[...vault.notes.keys()].join(", ")}`);
  return { path: hit[0], ...splitFrontmatter(hit[1]) };
};

describe("the vendored fixtures", () => {
  it("are the 16 public Keep notes of obsidian-importer 3.1.15, byte for byte (hashes in SOURCES.md)", () => {
    const sources = readFileSync(`${DIR}/SOURCES.md`, "utf8");
    expect(sources).toContain("2b483d0b351c99efa8e2dd94baa8563c83d01c38");
    expect(sources).toContain("not real exports");
    expect(names).toHaveLength(16);
    for (const n of names) {
      const sha = createHash("sha256").update(readFileSync(`${DIR}/keep/${n}`)).digest("hex");
      expect(sources, n).toContain(`| \`keep/${n}\` |`);
      expect(sources, n).toContain(sha);
    }
  });

  it("carry the MIT licence, and THIRD_PARTY_NOTICES.md names every ported file", () => {
    expect(readFileSync(`${DIR}/LICENSE`, "utf8")).toMatch(/^MIT License\n\nCopyright \(c\) 2023 Obsidian/);
    const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
    expect(notices).toContain("Permission is hereby granted, free of charge");
    for (const f of ["src/storage/import/keep.ts", "src/storage/import/notionDates.ts"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/[Pp]orted from obsidian-importer\s+3\.1\.15/);
      expect(notices, f).toContain(f);
    }
  });
});

describe("Google Keep, on the importer's notes", () => {
  it("every note but the trashed one comes in; nothing unreadable", () => {
    expect(vault.notes.size).toBe(15);
    expect(vault.skipped.map((s) => s.reason)).toEqual(["trashed"]);
  });

  it("rich text: Keep's inline CSS becomes bold, italic and underline", () => {
    const n = note("Rich text note");
    expect(n.body).toMatch(/\*\*Bold\*\*/);
    expect(n.body).toMatch(/(\*|_)italic\1/);
    expect(n.body).toContain("<u>underline</u>");
    expect(n.body).toContain("Heading");
    expect(n.props.tags).toEqual(["Rich"]);
  });

  it("rich checklist items keep their formatting, on one line each", () => {
    const n = note("Rich checklist note");
    expect(n.body).toMatch(/^- \[ \] \*\*rich item\*\*$/m);
    expect(n.body).toMatch(/^- \[x\] (\*|_)done item\1$/m);
  });

  it("a title with a line break: the first line names the note, both are aliases", () => {
    const n = note("Multiline title note");
    expect(n.props.aliases).toEqual(["Multiline title note", "Second line"]);
  });

  it("annotations become a list with their descriptions, and Keep tasks are marked", () => {
    const n = note("Annotated note");
    expect(n.body).toContain("## Annotations");
    expect(n.body).toContain("- [Submitting a Complaint to ICANN Contractual Compliance - ICANN](<https://www.icann.org/compliance/complaint>)");
    expect(n.body).toContain("  Here at Cloudflare, we make the Internet work the way it should.");
    expect(n.props).toMatchObject({ pinned: true, task: true });
  });

  it("dates come from Keep's microseconds; a never-edited note takes its creation time", () => {
    expect(note("Rich text note").props).toMatchObject({ created: expect.stringMatching(/^2025-11-1[34]/), updated: expect.stringMatching(/^2025-11-1[34]/) });
    const files = takeout();
    const raw = JSON.parse(new TextDecoder().decode(files.get("Takeout/Keep/Labelled note.json")!));
    files.set("Takeout/Keep/Labelled note.json", new TextEncoder().encode(JSON.stringify({ ...raw, userEditedTimestampUsec: 0 })));
    const v = convertKeep(files);
    const p = splitFrontmatter([...v.notes.entries()].find(([k]) => k.endsWith("Labelled note.md"))![1]).props;
    expect(p.updated).toBe(p.created);
  });

  it("archived notes go to Archive/, colours and labels are kept", () => {
    expect(note("Archived note").path).toBe("Archive/Archived note.md");
    expect(note("Background colour note").props.color).toMatch(/^[a-z]+$/);
  });
});

describe("Notion's localized dates (ported) and Hebrew (added)", () => {
  it.each([
    ["January 31, 2024", "2024-01-31"],
    ["January 31, 2024 10:00 AM", "2024-01-31T10:00"],
    ["@September 23, 2026 2:05 PM (PDT)", "2026-09-23T14:05"],
    ["Sept 23, 2026", "2026-09-23"],
    ["23 septembre 2026", "2026-09-23"],
    ["23. September 2026", "2026-09-23"],
    ["23 de septiembre de 2026", "2026-09-23"],
    ["23 de setembro de 2026", "2026-09-23"],
    ["2026年9月23日", "2026-09-23"],
    ["2026/09/23", "2026-09-23"],
    ["23/09/2026", "2026-09-23"],
    ["09/23/2026", "2026-09-23"],
    ["September 23, 2026 → September 25, 2026", "2026-09-23"],
    ["2026-09-23T10:05", "2026-09-23T10:05"],
    ["23 בספטמבר 2026", "2026-09-23"],
    ["23 בספט׳ 2026", "2026-09-23"],
    ["23 בספטמבר 2026 בשעה 10:05", "2026-09-23T10:05"],
    ["1 בינואר 2027", "2027-01-01"],
  ] as [string, string][])("%s → %s", (cell: string, want: string) => {
    expect(parseNotionDate(cell)).toBe(want);
  });

  it("Hebrew month names come from Intl's he-IL, so the forms the platform writes are read back", () => {
    for (let m = 0; m < 12; m++) {
      for (const month of ["long", "short"] as const) {
        const text = new Intl.DateTimeFormat("he-IL", { day: "numeric", month, year: "numeric" }).format(new Date(2026, m, 9));
        expect(parseNotionDate(text), text).toBe(`2026-${String(m + 1).padStart(2, "0")}-09`);
      }
    }
  });

  it.each([["February 30, 2026"], ["31/04/2026"], ["13:61"], ["not a date"], ["03/04/2026"], ["September 23, 2026 13:05 PM"]] as [string][])("%s is not a date (or not guessed)", (cell: string) => {
    expect(parseNotionDate(cell)).toBeNull();
  });

  it("a numeric column settles its order together: one 23/09 makes 03/04 the 3rd of April", () => {
    expect(inferOrder(["03/04/2026", "23/09/2026"])).toBe("day-first");
    expect(inferOrder(["03/04/2026", "09/23/2026"])).toBe("month-first");
    expect(inferOrder(["03/04/2026"])).toBeUndefined();
    expect(typeColumn(["03/04/2026", "23/09/2026", ""])).toEqual(["2026-04-03", "2026-09-23", null]);
    expect(typeColumn(["03/04/2026", "09/23/2026"])).toEqual(["2026-03-04", "2026-09-23"]);
  });

  it("a French or Hebrew date column is typed as dates (it stayed text before)", () => {
    expect(typeColumn(["23 septembre 2026", "1 octobre 2026"])).toEqual(["2026-09-23", "2026-10-01"]);
    expect(typeColumn(["23 בספטמבר 2026", "1 באוקטובר 2026"])).toEqual(["2026-09-23", "2026-10-01"]);
    expect(notionDate("23 בספטמבר 2026")).toBe("2026-09-23");
  });
});
