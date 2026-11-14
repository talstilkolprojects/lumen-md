/**
 * Obsidian compatibility against real vaults, not the docs (plan W4.30).
 *
 * fixtures/obsidian-corpus holds byte-for-byte copies of public vaults with
 * permissive licences, pinned to a commit (manifest.json: repo, commit,
 * licence, sha256 per file; `node scripts/obsidian-corpus.mjs --fetch`
 * downloads them again and checks every hash). Each test runs Lumen's own
 * open → save path over every file and counts the files that come back
 * byte-identical.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { basesFileFromText, parseBase, runBase, serializeBase, setViewSort } from "../views/bases/base";
import { readProperties, setProperty, FrontmatterError, type PropertyValue } from "../properties/frontmatter";
import { rewriteLinks } from "../storage/linkRewrite";
import { decodeUtf8, joinTextEnvelope, readText, splitTextEnvelope } from "../storage/textCodec";

interface ManifestVault {
  id: string;
  repo: string;
  commit: string;
  licence: string;
  licenceFile: string;
  files: Array<{ path: string; sha256: string }>;
}

const root = join(__dirname, "fixtures", "obsidian-corpus");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { vaults: ManifestVault[] };
const all = manifest.vaults.flatMap((v) => v.files.map((f) => ({ vault: v.id, path: f.path, sha256: f.sha256, bytes: new Uint8Array(readFileSync(join(root, v.id, f.path))) })));
const notes = all.filter((f) => f.path.endsWith(".md"));
const bases = all.filter((f) => f.path.endsWith(".base"));
const text = (f: { bytes: Uint8Array }) => decodeUtf8(f.bytes);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const enc = new TextEncoder();

/** What the editor does to a note: shows it (no BOM, LF), the user edits nothing, it is written back. */
const throughEditor = (t: string) => {
  const { body, envelope } = splitTextEnvelope(t);
  const shown = body.replace(/\r\n|\r/g, "\n"); // CodeMirror joins lines with LF
  return joinTextEnvelope(shown, envelope);
};

describe("Obsidian corpus manifest (W4.30)", () => {
  it("pins every vault to a commit with a permissive licence, and every file matches its hash", () => {
    expect(manifest.vaults.length).toBeGreaterThanOrEqual(7);
    for (const v of manifest.vaults) {
      expect(v.repo, v.id).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      expect(v.commit, v.id).toMatch(/^[0-9a-f]{40}$/);
      expect(v.licence, v.id).toMatch(/^(MIT|MIT AND CC-BY-4\.0)$/);
      expect(existsSync(join(root, v.id, "LICENSE.upstream")), v.id).toBe(true);
    }
    for (const f of all) expect(createHash("sha256").update(f.bytes).digest("hex"), `${f.vault}/${f.path}`).toBe(f.sha256);
    expect(notes.length).toBeGreaterThanOrEqual(300);
    expect(bases.length).toBeGreaterThanOrEqual(40);
  });

  it("covers the syntax that real vaults use", () => {
    const count = (re: RegExp) => notes.filter((f) => re.test(text(f))).length;
    expect(count(/^> ?\[![\w-]+\]/m), "callouts").toBeGreaterThanOrEqual(50);
    expect(count(/%%/), "%% comments").toBeGreaterThanOrEqual(3);
    expect(count(/!\[\[/), "embeds").toBeGreaterThanOrEqual(50);
    expect(count(/\s\^[A-Za-z0-9-]+$/m), "block ids").toBeGreaterThanOrEqual(3);
    expect(count(/^---\r?\n/), "frontmatter").toBeGreaterThanOrEqual(200);
    expect(count(/(^|\[|\()[A-Za-z][\w -]*:: /m), "Dataview inline fields").toBeGreaterThanOrEqual(3);
  });
});

describe("open → save, no edit (W4.30)", () => {
  it("every note is read and written back byte-identical", async () => {
    let same = 0;
    for (const f of notes) {
      const read = await readText(new Blob([f.bytes as BlobPart]));
      if (sameBytes(enc.encode(throughEditor(read)), f.bytes)) same++;
    }
    expect(same).toBe(notes.length);
  });

  it("the same notes saved by Windows (CRLF, BOM) keep their CRLF and BOM", async () => {
    let same = 0;
    for (const f of notes) {
      const win = "\uFEFF" + text(f).replace(/\r?\n/g, "\r\n");
      const bytes = enc.encode(win);
      const read = await readText(new Blob([bytes as BlobPart]));
      if (sameBytes(enc.encode(throughEditor(read)), bytes)) same++;
    }
    expect(same).toBe(notes.length);
  });

  it("an edit to one line of a CRLF note changes that line only", () => {
    const win = "---\r\ntitle: שלום\r\n---\r\n> [!note] כותרת\r\n> גוף\r\n\r\nטקסט ^block-1\r\n";
    const { body, envelope } = splitTextEnvelope(win);
    expect(joinTextEnvelope(body.replace("גוף", "גוף חדש"), envelope)).toBe(win.replace("גוף", "גוף חדש"));
  });
});

describe("properties: writing a value that is already there changes nothing (W4.30)", () => {
  it("every editable property of every real frontmatter", () => {
    let props = 0;
    let same = 0;
    const dupNotes: string[] = [];
    for (const f of notes) {
      const t = text(f);
      if (!/^\uFEFF?---\r?\n/.test(t)) continue;
      const ps = readProperties(t);
      const keys = ps.map((p) => p.key);
      if (new Set(keys).size !== keys.length) dupNotes.push(f.path);
      for (const p of ps) {
        if (!p.editable) continue;
        props++;
        if (setProperty(t, p.key, p.value as PropertyValue) === t) same++;
      }
    }
    expect(props).toBeGreaterThanOrEqual(2000);
    expect(same).toBe(props);
    // Real vaults write `tags:` twice; such a key is shown but not edited.
    expect(dupNotes.length).toBeGreaterThanOrEqual(5);
  });

  it("a key written twice is not editable, and writing it says why instead of editing the wrong one", () => {
    const t = "---\ntags: [MOCs]\nfolder: archive\ntags: [archive]\n---\n";
    expect(readProperties(t).filter((p) => p.key === "tags").every((p) => !p.editable)).toBe(true);
    expect(() => setProperty(t, "tags", ["x"])).toThrow(FrontmatterError);
    expect(setProperty(t, "folder", "a2")).toBe(t.replace("archive\ntags", "a2\ntags"));
  });
});

describe(".base files from real vaults (W4.30)", () => {
  it("every .base parses, and ≥ 95 % (here: all) save without an edit byte-identical", () => {
    let same = 0;
    for (const f of bases) {
      const t = text(f);
      const p = parseBase(t);
      expect(p.ok, `${f.vault}/${f.path}`).toBe(true);
      if (p.ok && serializeBase(p.doc) === t) same++;
    }
    expect(same / bases.length).toBeGreaterThanOrEqual(0.95);
    expect(same).toBe(bases.length);
  });

  it("clicking a column header rewrites only that view's sort", () => {
    for (const f of bases) {
      const t = text(f);
      const p = parseBase(t);
      if (!p.ok) continue;
      const w = setViewSort(t, 0, [{ property: "file.name", direction: "ASC" }]);
      expect(w.ok).toBe(true);
      if (!w.ok) continue;
      const before = t.split("\n");
      const after = w.text.split("\n");
      const gone = before.filter((l) => !after.includes(l));
      // Only sort lines (`sort:`, `- property:` / `- column:`, `direction:`) may go.
      expect(gone.filter((l) => !/^\s*(sort:|- (property|column):|direction:)/.test(l)), `${f.vault}/${f.path}`).toEqual([]);
    }
  });

  it("every view of every .base runs over its own vault without an error", () => {
    let views = 0;
    const errors: string[] = [];
    for (const v of manifest.vaults) {
      const mine = all.filter((f) => f.vault === v.id);
      const files = mine.map((f) => basesFileFromText(f.path, f.path.endsWith(".md") ? text(f) : null, { size: f.bytes.length, mtime: new Date("2026-01-01T00:00:00Z") }));
      for (const f of mine.filter((x) => x.path.endsWith(".base"))) {
        const p = parseBase(text(f));
        if (!p.ok) continue;
        const thisFile = files.find((x) => x.path === f.path) ?? null;
        p.base.views.forEach((view, i) => {
          views++;
          const r = runBase(p.base, files, { view: i, thisFile, now: new Date("2026-11-12T12:00:00Z") });
          for (const e of r.errors) errors.push(`${v.id}/${f.path} [${view.name}] ${e}`);
        });
      }
    }
    expect(views).toBeGreaterThanOrEqual(80);
    expect(errors).toEqual([]);
  });

  it("reads the 1.9 syntax real files still have: sort `column:`, top-level `display:`, not() and empty()", () => {
    const genre = bases.find((f) => f.path.endsWith("Templates/Bases/Genre.base"));
    expect(genre).toBeDefined();
    const p = parseBase(text(genre!));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.base.views[0].sort).toEqual([
      { property: "note.rating", direction: "DESC" },
      { property: "note.last", direction: "DESC" },
    ]);
    expect(p.base.displayNames["note.rating"]).toBe("Rating");
    const files = [
      basesFileFromText("a.md", "---\nlast: 2026-01-01\n---\n"),
      basesFileFromText("b.md", "---\nlast:\n---\n"),
    ];
    const shows = parseBase("views:\n  - type: table\n    name: Seen\n    filters: not(empty(note.last))\n");
    expect(shows.ok).toBe(true);
    if (shows.ok) expect(runBase(shows.base, files).rows.map((r) => r.file.path)).toEqual(["a.md"]);
    const blank = parseBase('formulas:\n  x: ""\nviews:\n  - type: table\n    name: T\n    order: [formula.x]\n');
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(runBase(blank.base, files).errors).toEqual([]);
  });
});

describe("renaming a note and renaming it back (W4.30)", () => {
  it("leaves every linking note byte-identical, except where Obsidian also writes the file's own name", () => {
    let checks = 0;
    const changed: string[] = [];
    for (const v of manifest.vaults) {
      const mine = notes.filter((f) => f.vault === v.id);
      const paths = mine.map((f) => f.path).sort();
      const texts = new Map(mine.map((f) => [f.path, text(f)]));
      for (const target of paths) {
        const renamed = target.replace(/\.md$/, " שונה.md");
        const after = paths.map((p) => (p === target ? renamed : p));
        for (const p of paths) {
          if (p === target) continue;
          const t = texts.get(p)!;
          const a = rewriteLinks(t, p, target, renamed, { vault: paths });
          if (a === t) continue;
          checks++;
          if (rewriteLinks(a, p, renamed, target, { vault: after }) !== t) changed.push(`${v.id}/${p} ← ${target}`);
        }
      }
    }
    expect(checks).toBeGreaterThanOrEqual(150);
    // `[[evergreen]]` comes back as `[[Evergreen]]`, the note's real name — what Obsidian writes too.
    expect(changed).toEqual(["kepano-obsidian/Notes/Evergreen notes turn ideas into objects that you can manipulate.md ← Categories/Evergreen.md"]);
  });

  it("keeps a ./ prefix and readable Hebrew names in Markdown links", () => {
    const t = "[א](./פרק%20אחד.md) [b](./b.md)";
    const out = rewriteLinks(t, "x.md", "פרק אחד.md", "פרק 1.md");
    expect(out).toBe("[א](./פרק%201.md) [b](./b.md)");
    const enc2 = "[a](%D7%90.md)";
    expect(rewriteLinks(enc2, "x.md", "א.md", "ב.md")).toBe("[a](%D7%91.md)");
  });
});
