/**
 * Database edits (4.10): one property of one note changes, byte for byte
 * nothing else; the open note goes through the editor; writes to a note
 * are queued; sorting and filtering of the rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import * as ws from "../storage/workspace";
import { NOTE_EDIT_EVENT, cellInputText, columnType, editNote, parseCellInput, writeCell, type NoteEditDetail } from "../views/databaseEdit";
import { NO_VALUE, applyQuery, groupKey, groupRows, kanbanColumnValue, loadDatabaseRows, parseSort, runDatabaseQuery, specView, type DatabaseRow } from "../views/database";
import { parseFilter } from "../views/databaseFilter";
import { FrontmatterError } from "../properties/frontmatter";
import { useAppStore } from "../store/useStore";
import { WORKSPACE_CHANGED } from "../storage/workspaceEvents";

const NOTE = [
  "---",
  "# a comment stays",
  "title: 'Invisible Cities'",
  "status: reading   # inline comment",
  "rating: 4",
  "tags: [fav, sci-fi]",
  "שפה: עברית",
  "---",
  "",
  "Body with status: reading in it.",
  "",
].join("\r\n");

beforeEach(() => {
  installFakeOpfs();
  useAppStore.setState((s) => ({ doc: { ...s.doc, workspaceName: null } }));
});
afterEach(() => vi.restoreAllMocks());

describe("writeCell", () => {
  it("replaces only the edited value — comments, quotes, CRLF, Hebrew and the body stay", async () => {
    await writeWorkspaceFile("books/a.md", NOTE);
    expect(await writeCell("books/a.md", "status", "done")).toBe(true);
    expect(await readWorkspaceFile("books/a.md")).toBe(NOTE.replace("status: reading   #", "status: done   #"));
    await writeCell("books/a.md", "שפה", "אנגלית");
    expect(await readWorkspaceFile("books/a.md")).toBe(NOTE.replace("status: reading   #", "status: done   #").replace("שפה: עברית", "שפה: אנגלית"));
  });

  it("keeps the style of the old value, writes numbers and lists, removes with undefined", async () => {
    await writeWorkspaceFile("a.md", NOTE);
    await writeCell("a.md", "title", "Le città invisibili");
    await writeCell("a.md", "rating", 5);
    await writeCell("a.md", "tags", ["fav"]);
    await writeCell("a.md", "שפה", undefined);
    const out = await readWorkspaceFile("a.md");
    expect(out).toContain("title: 'Le città invisibili'\r\n");
    expect(out).toContain("rating: 5\r\n");
    expect(out).toContain("tags: [fav]\r\n");
    expect(out).not.toContain("שפה");
    expect(out.endsWith("---\r\n\r\nBody with status: reading in it.\r\n")).toBe(true);
  });

  it("an unchanged value writes nothing and announces nothing", async () => {
    await writeWorkspaceFile("a.md", NOTE);
    const changed = vi.fn();
    window.addEventListener(WORKSPACE_CHANGED, changed);
    expect(await writeCell("a.md", "rating", 4)).toBe(false);
    window.removeEventListener(WORKSPACE_CHANGED, changed);
    expect(changed).not.toHaveBeenCalled();
  });

  it("a frontmatter that doesn't parse is never written", async () => {
    const broken = "---\nstatus: [unclosed\n---\nbody\n";
    await writeWorkspaceFile("bad.md", broken);
    await expect(writeCell("bad.md", "status", "done")).rejects.toBeInstanceOf(FrontmatterError);
    expect(await readWorkspaceFile("bad.md")).toBe(broken);
  });

  it("queues writes to one note, so neither is lost", async () => {
    await writeWorkspaceFile("a.md", NOTE);
    await Promise.all([writeCell("a.md", "status", "done"), writeCell("a.md", "rating", 1)]);
    const out = await readWorkspaceFile("a.md");
    expect(out).toContain("status: done");
    expect(out).toContain("rating: 1");
  });

  it("a note open in an inactive tab gets the change in its copy too, keeping its unsaved edits", async () => {
    await writeWorkspaceFile("books/a.md", NOTE);
    const unsaved = NOTE + "An unsaved line.\r\n";
    useAppStore.setState((s) => ({
      doc: { ...s.doc, workspaceName: "other.md" },
      openTabs: [
        { id: "other", name: "other.md", content: "x", workspaceName: "other.md", dirty: false },
        { id: "books/a.md", name: "a.md", content: unsaved, workspaceName: "books/a.md", dirty: true },
      ],
    }));
    await writeCell("books/a.md", "status", "done");
    const tab = useAppStore.getState().openTabs.find((t) => t.workspaceName === "books/a.md")!;
    expect(tab.content).toBe(unsaved.replace("status: reading", "status: done"));
    expect(tab.dirty).toBe(true);
    expect(await readWorkspaceFile("books/a.md")).toBe(NOTE.replace("status: reading", "status: done"));
    useAppStore.setState({ openTabs: [] });
  });

  it("a failed write leaves the inactive tab as it was", async () => {
    await writeWorkspaceFile("books/a.md", NOTE);
    useAppStore.setState((s) => ({
      doc: { ...s.doc, workspaceName: "other.md" },
      openTabs: [{ id: "books/a.md", name: "a.md", content: NOTE, workspaceName: "books/a.md", dirty: false }],
    }));
    vi.spyOn(ws, "writeWorkspaceFile").mockRejectedValueOnce(new Error("quota"));
    await expect(writeCell("books/a.md", "status", "done")).rejects.toThrow("quota");
    expect(useAppStore.getState().openTabs[0].content).toBe(NOTE);
    useAppStore.setState({ openTabs: [] });
  });

  it("the open note is edited through the app (its editor), not behind it", async () => {
    await writeWorkspaceFile("open.md", NOTE);
    useAppStore.setState((s) => ({ doc: { ...s.doc, workspaceName: "open.md" } }));
    let editorText = NOTE;
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent<NoteEditDetail>).detail;
      const next = d.edit(editorText);
      d.done(next !== editorText);
      editorText = next;
    };
    window.addEventListener(NOTE_EDIT_EVENT, onEdit);
    expect(await editNote("open.md", (t) => t.replace("rating: 4", "rating: 3"))).toBe(true);
    window.removeEventListener(NOTE_EDIT_EVENT, onEdit);
    expect(editorText).toContain("rating: 3");
    expect(await readWorkspaceFile("open.md")).toBe(NOTE);
  });
});

describe("kanban moves", () => {
  it("grouped by a list (tags), a move writes the column's list as a YAML list", async () => {
    await writeWorkspaceFile("t/one.md", "---\ntype: task\ntags: [todo]\n---\nbody\n");
    await writeWorkspaceFile("t/two.md", "---\ntype: task\ntags: [fav, sci-fi]\n---\n");
    const rows = await loadDatabaseRows({ source: "t", type: "task" });
    const groups = groupRows(rows, "tags");
    expect([...groups.keys()]).toEqual(["todo", "fav,sci-fi"]);
    const type = columnType(rows.map((r) => r.fm.tags), "tags");
    const value = kanbanColumnValue("fav,sci-fi", groups.get("fav,sci-fi")![0].fm.tags, type);
    expect(value).toEqual(["fav", "sci-fi"]);
    await writeCell("t/one.md", "tags", value);
    expect(await readWorkspaceFile("t/one.md")).toBe("---\ntype: task\ntags: [fav, sci-fi]\n---\nbody\n");
    // An empty listed column of a list property: a one-item list.
    expect(kanbanColumnValue("later", undefined, type)).toEqual(["later"]);
    // Numbers stay numbers, NO_VALUE removes.
    expect(kanbanColumnValue("3", 3, "number")).toBe(3);
    expect(kanbanColumnValue("4", undefined, "number")).toBe(4);
    expect(kanbanColumnValue(NO_VALUE, undefined, "text")).toBeUndefined();
  });

  it("an empty checkbox column writes a boolean, not the text (W1.32, #231)", () => {
    expect(kanbanColumnValue("false", undefined, "checkbox")).toBe(false);
    expect(kanbanColumnValue("true", undefined, "checkbox")).toBe(true);
    expect(kanbanColumnValue("maybe", undefined, "checkbox")).toBe("maybe");
  });

  it("lists that join to the same text keep separate columns (W1.32, #231)", async () => {
    await writeWorkspaceFile("l/one.md", '---\ntype: task\ntags: ["a,b"]\n---\n');
    await writeWorkspaceFile("l/two.md", "---\ntype: task\ntags: [a, b]\n---\n");
    const rows = await loadDatabaseRows({ source: "l", type: "task" });
    const groups = groupRows(rows, "tags");
    expect([...groups.keys()].sort()).toEqual(['["a,b"]', "a,b"]);
    const type = columnType(rows.map((r) => r.fm.tags), "tags");
    expect(kanbanColumnValue("a,b", groups.get("a,b")![0].fm.tags, type)).toEqual(["a", "b"]);
    expect(kanbanColumnValue('["a,b"]', groups.get('["a,b"]')![0].fm.tags, type)).toEqual(["a,b"]);
    expect(groupKey(["fav", "sci-fi"])).toBe("fav,sci-fi");
    expect(groupKey("")).toBe(NO_VALUE);
  });
});

describe("cell values", () => {
  it("typed text becomes the column's type", () => {
    expect(parseCellInput(" 4.5 ", "number")).toBe(4.5);
    expect(parseCellInput("four", "number")).toBe("four");
    expect(parseCellInput("", "number")).toBeNull();
    expect(parseCellInput("a, b ,", "list")).toEqual(["a", "b"]);
    expect(parseCellInput("שלום", "text")).toBe("שלום");
    expect(cellInputText(["a", "b"])).toBe("a, b");
    expect(columnType([undefined, 3], "x")).toBe("number");
    expect(columnType([], "tags")).toBe("list");
  });
});

describe("query", () => {
  const rows: DatabaseRow[] = [
    { path: "b.md", basename: "b", fm: { rating: 5, status: "done" } },
    { path: "a.md", basename: "a", fm: { rating: 5, status: "todo" } },
    { path: "c.md", basename: "c", fm: { status: "todo" } },
    { path: "d.md", basename: "d", fm: { rating: 2, status: "todo" } },
  ];

  it("sorts by several keys, missing values last, ties by name", () => {
    expect(parseSort(["-rating", "status asc"])).toEqual([{ key: "rating", desc: true }, { key: "status", desc: false }]);
    expect(parseSort("rating desc, status")).toEqual([{ key: "rating", desc: true }, { key: "status", desc: false }]);
    expect(applyQuery(rows, { sort: parseSort("-rating, -status") }).map((r) => r.basename)).toEqual(["a", "b", "d", "c"]);
    expect(applyQuery(rows, { sort: parseSort("rating") }).map((r) => r.basename)).toEqual(["d", "a", "b", "c"]);
  });

  it("filters with the expression tree", () => {
    const where = parseFilter('status = "todo" AND (rating >= 4 OR empty(rating))');
    expect(where.ok && applyQuery(rows, { where: where.tree }).map((r) => r.basename)).toEqual(["a", "c"]);
  });

  it("runDatabaseQuery applies the spec's where and sort; a bad where is an error", async () => {
    await writeWorkspaceFile("t/one.md", "---\ntype: task\nstatus: todo\n---\n");
    await writeWorkspaceFile("t/two.md", "---\ntype: task\nstatus: done\n---\n");
    await writeWorkspaceFile("t/other.md", "---\ntype: book\n---\n");
    expect((await loadDatabaseRows({ source: "t", type: "task" })).map((r) => r.basename)).toEqual(["one", "two"]);
    expect((await runDatabaseQuery({ source: "t", type: "task", where: 'status != "done"' })).map((r) => r.basename)).toEqual(["one"]);
    await expect(runDatabaseQuery({ where: "status =" })).rejects.toThrow(/where: expression ends too early/);
  });

  it("old view names still work", () => {
    expect(specView({ view: "gallery" })).toBe("cards");
    expect(specView({})).toBe("table");
    expect(specView({ view: "list" })).toBe("list");
  });
});
