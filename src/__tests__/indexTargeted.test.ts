/**
 * W6.36 — embeds and `[[` completion ask the index for the notes they need,
 * not for every note's text. Each answer must be what reading every note
 * gave (W2.22's `indexedNotes()`), with a handful of notes read instead of
 * the vault.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import { __resetWorkspaceIndex, ensureIndex, indexedNotes } from "../storage/workspaceIndex";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";
import type { IndexEngine } from "../storage/vaultIndexProtocol";
import { createEmbedContext, embeddedTexts, missingEmbedded } from "../renderer/embeds";
import { embedNotice, loadEmbedContext } from "../renderer/embedContext";
import { linkCatalog } from "../editor/wikiLinkData";
import { frontmatterAliases, noteCatalog, parseWikiQuery, wikiSuggestions } from "../editor/wikiComplete";

const N = 2000;
/** Paths each `texts` request asked for (undefined = every note). */
let asked: Array<string[] | undefined> = [];
const counting = (): IndexEngine => {
  const e = localEngine(new VaultIndex());
  return { ...e, texts: (paths) => (asked.push(paths ? [...paths] : undefined), e.texts(paths)) };
};

let previous: VaultBackend | null;
beforeEach(async () => {
  const b = createMemoryBackend();
  for (let i = 0; i < N; i++) await b.write(`notes/n${i}.md`, `# Note ${i}\n\n## Part ${i}\n\ntext ${i} ^b${i}\n`);
  await b.write("hub/A.md", "---\naliases: [Alpha, \"אלפא\"]\n---\n# A\n![[B]]\n![[B#Part]]\n");
  await b.write("hub/B.md", "# B\n## Part\nb text\n![[C]]\n![[A]]\n");
  await b.write("hub/C.md", "# C\n![[D]]\n");
  await b.write("hub/D.md", "# D\n![[E]]\n");
  await b.write("hub/E.md", "# E deep\n");
  await b.write("other/B.md", "# the other B\n");
  previous = setVaultBackend(b);
  __resetWorkspaceIndex(counting);
  await ensureIndex();
  asked = [];
});
afterEach(() => setVaultBackend(previous));

describe("embeds read only what they embed (W6.36)", () => {
  const HOST = "intro\n![[A]]\n![[n17]] ![[n17#Part 17]]\n![[missing]]\n";

  it("the same context as with every note, from a few notes", async () => {
    const ctx = await loadEmbedContext(HOST, "ws:host.md");
    expect(ctx).toBeDefined();
    // At most one request per embed level, none for the whole vault.
    expect(asked.length).toBeLessThanOrEqual(4);
    expect(asked.every((p) => p !== undefined)).toBe(true);
    const read = new Set(asked.flat());
    expect(read.size).toBeLessThanOrEqual(6);
    // What W2.22 did: every note's text.
    const all = await indexedNotes();
    const full = createEmbedContext({ hostPath: "host.md", hostText: HOST, files: all, notice: embedNotice });
    expect(embeddedTexts(HOST, ctx!)).toEqual(embeddedTexts(HOST, full));
    for (const p of ["hub/A.md", "hub/B.md", "hub/C.md", "notes/n17.md"]) expect(ctx!.read(p)).toBe(full.read(p));
    expect(ctx!.paths.length).toBe(full.paths.length);
    expect(missingEmbedded(HOST, ctx!)).toEqual([]);
  });

  it("missingEmbedded follows the levels and stops at the depth limit", () => {
    const paths = ["hub/A.md", "hub/B.md", "hub/C.md", "hub/D.md", "hub/E.md"];
    const texts = new Map<string, string>();
    const ctx = () => createEmbedContext({ hostPath: null, hostText: "", files: paths.map((path) => ({ path, content: texts.get(path) })), notice: embedNotice });
    expect(missingEmbedded("![[A]]", ctx())).toEqual(["hub/A.md"]);
    texts.set("hub/A.md", "![[B]]");
    expect(missingEmbedded("![[A]]", ctx())).toEqual(["hub/B.md"]);
    texts.set("hub/B.md", "![[C]]");
    expect(missingEmbedded("![[A]]", ctx())).toEqual(["hub/C.md"]);
    texts.set("hub/C.md", "![[D]]");
    // A (0) → B (1) → C (2): C's own embeds are past MAX_EMBED_DEPTH (3).
    expect(missingEmbedded("![[A]]", ctx())).toEqual([]);
  });
});

describe("[[ completion reads one note, and only for # and ^ (W6.36)", () => {
  it("note names and aliases come from the summaries: no note text is read", async () => {
    const catalog = await linkCatalog();
    expect(asked).toEqual([]);
    const full = noteCatalog(await indexedNotes());
    for (const typed of ["[[alp", "[[אלפ", "[[n19", "[[B"]) {
      const q = parseWikiQuery(typed)!;
      expect(wikiSuggestions(q, catalog, undefined, { create: true })).toEqual(wikiSuggestions(q, full, undefined, { create: true }));
    }
    const a = catalog.notes.find((n) => n.path === "hub/A.md")!;
    expect(a.aliases).toEqual(frontmatterAliases("---\naliases: [Alpha, \"אלפא\"]\n---\n"));
  });

  it("[[Note# and [[Note^ read that note alone and offer what the full text gave", async () => {
    const full = noteCatalog(await indexedNotes());
    asked = [];
    for (const typed of ["[[n42#", "[[n42#Pa", "[[n42^b", "[[n42#^"]) {
      const q = parseWikiQuery(typed)!;
      const got = wikiSuggestions(q, await linkCatalog(q), undefined);
      expect(got.length).toBeGreaterThan(0);
      expect(got).toEqual(wikiSuggestions(q, full, undefined));
    }
    expect(asked).toEqual([["notes/n42.md"], ["notes/n42.md"], ["notes/n42.md"], ["notes/n42.md"]]);
    // The open note's own headings come from the editor, not the index.
    asked = [];
    const q = parseWikiQuery("[[n42#")!;
    await linkCatalog(q, { path: "notes/n42.md", content: "# live" });
    expect(asked).toEqual([]);
  });
});
