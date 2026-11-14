/**
 * T47 — the whole vault out and back in: zip export keeps paths and Hebrew
 * names, folder export writes the tree, import detects Obsidian / Notion,
 * cleans Notion's IDs and links, never overwrites, skips app folders.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { installFakeOpfs, FakeDir } from "./helpers/fakeOpfs";
import { listWorkspace, readWorkspaceFile, writeWorkspaceBlob, writeWorkspaceFile } from "../storage/workspace";
import { collectVault, detectSource, exportVaultToFolder, exportVaultZip, importFiles, importZip, rewriteNotionLinks, stripNotionIds } from "../storage/exportAll";
import { unzip, zip } from "../storage/zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

beforeEach(() => {
  installFakeOpfs();
});

describe("export", () => {
  it("zips every note and attachment with its folder path, Hebrew names included, trash excluded", async () => {
    await writeWorkspaceFile("שלום.md", "# שלום");
    await writeWorkspaceFile("proj/a.md", "A");
    await writeWorkspaceBlob("proj/img.png", new Blob([new Uint8Array([1, 2, 3])]));
    await writeWorkspaceFile(".trash/x/old.md", "gone");
    const { bytes, files } = await exportVaultZip();
    expect(files).toBe(3);
    const back = await unzip(bytes.buffer);
    expect([...back.keys()].sort()).toEqual(["proj/a.md", "proj/img.png", "שלום.md"]);
    expect(dec.decode(back.get("שלום.md"))).toBe("# שלום");
    expect([...back.get("proj/img.png")!]).toEqual([1, 2, 3]);
    // UTF-8 name flag set for the Hebrew name (central directory)
    const view = new DataView(bytes.buffer);
    let ok = false;
    for (let i = 0; i < bytes.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50 && (view.getUint16(i + 8, true) & 0x0800)) ok = true;
    expect(ok).toBe(true);
  });

  it("writes the tree into a new subfolder of the picked folder, never over its files", async () => {
    await writeWorkspaceFile("a/b/c.md", "C");
    await writeWorkspaceFile("README.md", "vault readme");
    const target = new FakeDir("out");
    const mine = await target.getFileHandle("README.md", { create: true });
    const w = await mine.createWritable();
    await w.write("my own readme");
    await w.close();
    await target.getDirectoryHandle("lumen-vault", { create: true });
    const r = await exportVaultToFolder(target as unknown as Parameters<typeof exportVaultToFolder>[0], "lumen-vault");
    expect(r).toEqual({ files: 2, folder: "lumen-vault 2" });
    expect(await (await (await target.getFileHandle("README.md")).getFile()).text()).toBe("my own readme");
    const a = await (await target.getDirectoryHandle("lumen-vault 2")).getDirectoryHandle("a");
    const b = await a.getDirectoryHandle("b");
    expect(await (await (await b.getFileHandle("c.md")).getFile()).text()).toBe("C");
  });
});

describe("import", () => {
  it("detects the source", () => {
    expect(detectSource(["vault/.obsidian/app.json", "vault/a.md"])).toBe("obsidian");
    expect(detectSource(["Export/Page 0123456789abcdef0123456789abcdef.md"])).toBe("notion");
    expect(detectSource(["a.md", "b/c.md"])).toBe("lumen");
  });

  it("cleans Notion IDs from names and links", () => {
    expect(stripNotionIds("Home 0123456789abcdef0123456789abcdef/Sub 89abcdef0123456789abcdef01234567.md")).toBe("Home/Sub.md");
    expect(rewriteNotionLinks("[Sub](Home%200123456789abcdef0123456789abcdef/Sub%2089abcdef0123456789abcdef01234567.md) [x](https://notion.so/a)")).toBe("[Sub](Home/Sub.md) [x](https://notion.so/a)");
  });

  it("imports an Obsidian vault into a new folder, skipping .obsidian, never overwriting", async () => {
    await writeWorkspaceFile("Imported/MyVault/note.md", "existing");
    const files = new Map<string, Uint8Array>([
      ["MyVault/.obsidian/workspace.json", enc.encode("{}")],
      ["MyVault/note.md", enc.encode("see [[other]]")],
      ["MyVault/sub/other.md", enc.encode("# other")],
      ["MyVault/assets/pic.png", new Uint8Array([9])],
    ]);
    const r = await importFiles(files, "MyVault");
    expect(r.source).toBe("obsidian");
    expect(r.folder).toBe("Imported/MyVault 2");
    expect([r.notes, r.attachments]).toEqual([2, 1]);
    expect(r.skipped).toEqual(["MyVault/.obsidian/workspace.json"]);
    expect(await readWorkspaceFile("Imported/MyVault 2/note.md")).toBe("see [[other]]");
    expect(await readWorkspaceFile("Imported/MyVault/note.md")).toBe("existing");
    // Plan 2.7: agents treat the imported notes as outside content.
    const { untrustedSourcesOfNote } = await import("../agents/provenance");
    expect(untrustedSourcesOfNote("Imported/MyVault 2/sub/other.md")).toEqual(["imported (obsidian) (Imported/MyVault 2/sub/other.md)"]);
    // Everything under Imported/ came from an import (also before the guard existed): recognised by its path.
    expect(untrustedSourcesOfNote("Imported/MyVault/note.md")).toEqual(["imported (Imported/MyVault/note.md)"]);
  });

  it("round-trips: export → import gives the same notes", async () => {
    await writeWorkspaceFile("x/y.md", "Y");
    const { bytes } = await exportVaultZip();
    const r = await importZip(bytes.buffer as ArrayBuffer, "backup.zip");
    expect(r.source).toBe("lumen");
    expect(await readWorkspaceFile(`${r.folder}/x/y.md`)).toBe("Y");
    expect((await listWorkspace()).length).toBe(2);
  });

  it("keeps a #heading or ?query when cleaning a Notion link", () => {
    expect(rewriteNotionLinks("[s](Page%200123456789abcdef0123456789abcdef.md#section)")).toBe("[s](Page.md#section)");
  });

  it("links follow a Notion page renamed because another page has the same title", async () => {
    const id1 = "0123456789abcdef0123456789abcdef", id2 = "89abcdef0123456789abcdef01234567";
    const archive = await zip([
      { name: `Export-x/Home.md`, data: `[one](Page%20${id1}.md) [two](Page%20${id2}.md#h)` },
      { name: `Export-x/Page ${id1}.md`, data: "# one" },
      { name: `Export-x/Page ${id2}.md`, data: "# two" },
    ]);
    const r = await importZip(archive.buffer as ArrayBuffer, "Export-x.zip");
    expect(await readWorkspaceFile(`${r.folder}/Page.md`)).toBe("# one");
    expect(await readWorkspaceFile(`${r.folder}/Page 2.md`)).toBe("# two");
    expect(await readWorkspaceFile(`${r.folder}/Home.md`)).toBe("[one](Page.md) [two](Page%202.md#h)");
  });

  it("strips only the archive's wrapper folder, not a folder all notes share", async () => {
    const files = new Map<string, Uint8Array>([
      ["Vault/.obsidian/app.json", enc.encode("{}")],
      ["Vault/Projects/a.md", enc.encode("A")],
      ["Vault/Projects/b.md", enc.encode("B")],
    ]);
    const r = await importFiles(files, "Vault");
    expect(await readWorkspaceFile(`${r.folder}/Projects/a.md`)).toBe("A");
    expect(await readWorkspaceFile(`${r.folder}/Projects/b.md`)).toBe("B");
  });

  it("imports a Notion zip with clean names and working links", async () => {
    const id1 = "0123456789abcdef0123456789abcdef", id2 = "89abcdef0123456789abcdef01234567";
    const archive = await zip([
      { name: `Export-x/Home ${id1}.md`, data: `# Home\n[Sub](Home%20${id1}/Sub%20${id2}.md)` },
      { name: `Export-x/Home ${id1}/Sub ${id2}.md`, data: "# Sub" },
    ]);
    const r = await importZip(archive.buffer as ArrayBuffer, "Export-x.zip");
    expect(r.source).toBe("notion");
    expect(await readWorkspaceFile(`${r.folder}/Home.md`)).toBe("# Home\n[Sub](Home/Sub.md)");
    expect(await readWorkspaceFile(`${r.folder}/Home/Sub.md`)).toBe("# Sub");
    expect((await collectVault()).map((f) => f.path).sort()).toEqual([`${r.folder}/Home.md`, `${r.folder}/Home/Sub.md`]);
  });
});
