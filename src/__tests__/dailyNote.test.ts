/**
 * Plan 4.12 — daily notes and the calendar: paths from the configured
 * folder / pattern, templates with {{date}} and {{hebrewDate}}, the Hebrew
 * date against the hebrew-dates golden set (dev split; the test split is
 * scored in CI by scripts/golden/evals/hebrew-dates.mjs), create-once /
 * open-again without duplicates, and the locale-aware month grid.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs module without types
import { loadSet } from "../../scripts/lib/golden.mjs";
// @ts-expect-error — plain .mjs module without types
import { parseHebrewText, score, toGregorian } from "../../scripts/golden/evals/hebrew-dates.mjs";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { useAppStore } from "../store/useStore";
import { listWorkspace, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { DEFAULT_DAILY, cleanFolder, gematria, isValidDailyPattern, dailyPath, dayOfPath, ensureDailyNote, fileNameFor, hebrewDate, hebrewParts, openDailyNote, parseIso, renderTemplate } from "../daily/dailyNote";
import { firstDayOfWeek, hebrewMonthsOf, monthGrid } from "../ui/CalendarPanel";

type DevItem = { id: string; direction: string; gregorian: string; hebrewText: string; hebrew: { day: number; month: string; monthHe: string; year: number } };
const golden = join(resolve(__dirname, "../.."), "eval", "golden");
const devItems = (): DevItem[] => loadSet(golden, "hebrew-dates").items;

describe("Hebrew date (Intl he-u-ca-hebrew only)", () => {
  it("matches every item of the hebrew-dates dev split", () => {
    const items = devItems();
    expect(items.length).toBe(5); // 5 dev + 15 test = the set's 20
    for (const it of items) {
      const day = parseIso(it.gregorian)!;
      expect(hebrewParts(day), it.id).toEqual({ day: it.hebrew.day, month: it.hebrew.monthHe, year: it.hebrew.year });
      expect(hebrewDate(day), it.id).toBe(it.hebrewText);
      expect(toGregorian(parseHebrewText(it.hebrewText)), it.id).toBe(it.gregorian);
    }
  });

  it("the CI harness scores the dev split at 100%", async () => {
    expect(await score({ items: devItems() })).toEqual({ exact: 1, to_hebrew_exact: 1, to_gregorian_exact: 1 });
  });

  it("leap-year Adar and the new year", () => {
    expect(hebrewParts({ y: 2024, m: 3, d: 15 })).toEqual({ day: 5, month: "אדר ב׳", year: 5784 });
    expect(hebrewParts({ y: 2026, m: 9, d: 12 })).toMatchObject({ day: 1, year: 5787 });
    expect(hebrewDate({ y: 2026, m: 10, d: 18 })).toBe("ז׳ בחשוון תשפ״ז");
    expect(hebrewDate({ y: 1972, m: 10, d: 24 })).toBe("ט״ז בחשוון תשל״ג");
    expect(gematria(15)).toBe("ט״ו");
    expect(gematria(800)).toBe("ת״ת");
  });
});

describe("paths", () => {
  const s = { folder: "journal", pattern: "YYYY-MM-DD" };
  it("journal/YYYY-MM-DD.md by default", () => {
    expect(dailyPath({ y: 2026, m: 1, d: 5 }, s)).toBe("journal/2026-01-05.md");
    expect(dailyPath({ y: 2026, m: 1, d: 5 }, DEFAULT_DAILY)).toBe("journal/2026-01-05.md");
  });
  it("custom folder and pattern", () => {
    const c = { folder: "/diary/./2026/../daily/", pattern: "DD.MM.YYYY" };
    expect(cleanFolder(c.folder)).toBe("diary/2026/daily");
    expect(dailyPath({ y: 2026, m: 10, d: 18 }, c)).toBe("diary/2026/daily/18.10.2026.md");
    expect(dayOfPath("diary/2026/daily/18.10.2026.md", c)).toEqual({ y: 2026, m: 10, d: 18 });
    expect(fileNameFor({ y: 2026, m: 10, d: 18 }, "YYYY/MM/DD")).toBe("2026-10-18.md");
    expect(fileNameFor({ y: 2026, m: 10, d: 18 }, "YYYY-MM-DD.markdown")).toBe("2026-10-18.markdown");
    expect(dailyPath({ y: 2026, m: 10, d: 18 }, { folder: "", pattern: "" })).toBe("2026-10-18.md");
  });
  it("dayOfPath recognises only this pattern's real days", () => {
    expect(dayOfPath("journal/2026-10-18.md", s)).toEqual({ y: 2026, m: 10, d: 18 });
    expect(dayOfPath("journal/2026-02-30.md", s)).toBeNull();
    expect(dayOfPath("journal/sub/2026-10-18.md", s)).toBeNull();
    expect(dayOfPath("notes/2026-10-18.md", s)).toBeNull();
    expect(dayOfPath("journal/2026-10-18 copy.md", s)).toBeNull();
  });
  it("a pattern without YYYY, MM and DD is refused (days would share a file)", () => {
    expect(isValidDailyPattern("YYYY-MM")).toBe(false);
    expect(isValidDailyPattern("DD.MM.YYYY")).toBe(true);
    expect(fileNameFor({ y: 2026, m: 10, d: 18 }, "YYYY-MM")).toBe("2026-10-18.md");
    expect(dayOfPath("journal/2026-10-18.md", { folder: "journal", pattern: "YYYY-MM" })).toEqual({ y: 2026, m: 10, d: 18 });
    useAppStore.getState().setDailyNotes({ pattern: "YYYY-MM-DD" });
    useAppStore.getState().setDailyNotes({ pattern: "YYYY-MM", folder: "days" });
    expect(useAppStore.getState().dailyNotes).toMatchObject({ pattern: "YYYY-MM-DD", folder: "days" });
    useAppStore.getState().setDailyNotes({ ...DEFAULT_DAILY });
  });
});

describe("template", () => {
  it("fills {{date}}, {{hebrewDate}}, {{weekday}} and {{title}}", () => {
    const out = renderTemplate("{{date}}|{{ hebrewDate }}|{{weekday}}|{{title}}|{{other}}", { y: 2026, m: 10, d: 18 }, "en");
    expect(out).toBe("2026-10-18|\u2067ז׳ בחשוון תשפ״ז\u2069|Sunday|Sunday, October 18, 2026|{{other}}");
    expect(renderTemplate("{{weekday}}", { y: 2026, m: 10, d: 18 }, "he")).toBe("יום ראשון");
  });
});

describe("open or create", () => {
  const settings = { ...DEFAULT_DAILY, template: "# {{date}}\n" };
  const day = { y: 2026, m: 10, d: 18 };
  beforeEach(() => {
    installFakeOpfs();
    useAppStore.setState({ doc: { name: "Untitled.md", content: "", dirty: false, workspaceName: null }, openTabs: [] });
  });

  it("creates the note once, even for two calls at the same time", async () => {
    const [a, b] = await Promise.all([ensureDailyNote(day, settings, "en"), ensureDailyNote(day, settings, "en")]);
    expect(a).toBe("journal/2026-10-18.md");
    expect(b).toBe(a);
    expect((await listWorkspace()).map((f) => f.path)).toEqual(["journal/2026-10-18.md"]);
    expect(await readWorkspaceFile(a)).toBe("# 2026-10-18\n");
  });

  it("an empty template gives an empty note (not the default)", async () => {
    const p = await ensureDailyNote(day, { ...settings, template: "" }, "en");
    expect(await readWorkspaceFile(p)).toBe("");
  });

  it("never overwrites an existing note", async () => {
    await writeWorkspaceFile("journal/2026-10-18.md", "mine");
    await ensureDailyNote(day, settings, "en");
    expect(await readWorkspaceFile("journal/2026-10-18.md")).toBe("mine");
  });

  it("opening again gives one tab and keeps unsaved edits", async () => {
    await openDailyNote(day, settings, "en");
    let s = useAppStore.getState();
    expect(s.doc.workspaceName).toBe("journal/2026-10-18.md");
    expect(s.doc.content).toBe("# 2026-10-18\n");
    s.setContent("# 2026-10-18\nunsaved");
    await openDailyNote(day, settings, "en");
    s = useAppStore.getState();
    expect(s.openTabs.filter((t) => t.workspaceName === "journal/2026-10-18.md").length).toBeLessThanOrEqual(1);
    expect(s.doc.workspaceName).toBe("journal/2026-10-18.md");
    expect(s.doc.content).toBe("# 2026-10-18\nunsaved");
    expect((await listWorkspace()).length).toBe(1);
    // From another note and back: the tab is focused, not reopened from disk.
    s.openTab({ name: "other.md", content: "x", workspaceName: "other.md" });
    await openDailyNote(day, settings, "en");
    s = useAppStore.getState();
    expect(s.doc.workspaceName).toBe("journal/2026-10-18.md");
    expect(s.doc.content).toBe("# 2026-10-18\nunsaved");
    expect(s.openTabs.filter((t) => t.workspaceName === "journal/2026-10-18.md").length).toBe(1);
  });
});

describe("calendar grid", () => {
  it("showing the calendar shows the file sidebar it lives in", () => {
    useAppStore.setState({ showWorkspace: false, showCalendar: false });
    useAppStore.getState().toggleCalendar();
    expect(useAppStore.getState()).toMatchObject({ showWorkspace: true, showCalendar: true });
    useAppStore.setState({ showWorkspace: false });
    useAppStore.getState().toggleCalendar(); // on but hidden: show, don't hide
    expect(useAppStore.getState()).toMatchObject({ showWorkspace: true, showCalendar: true });
    useAppStore.getState().toggleCalendar();
    expect(useAppStore.getState()).toMatchObject({ showWorkspace: true, showCalendar: false });
  });
  it("lists every Hebrew month a Gregorian month touches", () => {
    expect(hebrewMonthsOf(2022, 5)).toEqual(["ניסן 5782", "אייר 5782", "סיוון 5782"]);
    expect(hebrewMonthsOf(2026, 10).length).toBe(2);
  });
  it("week start by locale", () => {
    expect(firstDayOfWeek("he")).toBe(7);
    expect(firstDayOfWeek("en")).toBe(7);
    expect(firstDayOfWeek("de")).toBe(1);
    expect(firstDayOfWeek("fr")).toBe(1);
    expect(firstDayOfWeek("ar")).toBe(6);
  });
  it("October 2026 (starts on a Thursday)", () => {
    const sun = monthGrid(2026, 10, 7);
    expect(sun[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(sun[0][4]).toEqual({ y: 2026, m: 10, d: 1 });
    const mon = monthGrid(2026, 10, 1);
    expect(mon[0].filter((c) => c === null).length).toBe(3);
    for (const g of [sun, mon, monthGrid(2026, 10, 6)]) {
      expect(g.every((r) => r.length === 7)).toBe(true);
      expect(g.flat().filter(Boolean).length).toBe(31);
    }
    expect(monthGrid(2024, 2, 1).flat().filter(Boolean).length).toBe(29);
  });
});
