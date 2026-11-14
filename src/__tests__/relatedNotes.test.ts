/**
 * Plan W2.2 — related notes and suggested links while writing.
 *  - recall@5 ≥ 70% on the gold set (100 pairs, Hebrew and English);
 *  - the update after typing stops fits in 150 ms (debounce + ranking on
 *    10,000 notes);
 *  - nothing runs per keystroke (the plugin only resets a timer), and the
 *    text changes only when a hint is accepted;
 *  - off per note (front matter) and per folder.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Bm25Index } from "../search/bm25";
import { linkHints, linkText, paragraphAt, relatedNotes, salientTerms, titleEntries, fuseRanks } from "../related/related";
import { acceptHint, currentHints, relatedExtension } from "../related/editorPlugin";
import { folderOff, noteOptsOut, offFolders, relatedOff, setFolderOff } from "../related/prefs";
import { RELATED_DELAY_MS } from "../ui/RelatedPanel";
import { goldVault } from "./fixtures/relatedGold";

const nameOf = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
const body = (text: string) => text.replace(/^# .*\n\n/, "");

describe("related notes", () => {
  it("gold set: recall@5 ≥ 70% over 100 pairs (Hebrew and English)", () => {
    const { notes, pairs } = goldVault();
    expect(pairs).toHaveLength(100);
    const index = new Bm25Index();
    for (const n of notes) index.set(n.path, n.text, nameOf(n.path));
    const byPath = new Map(notes.map((n) => [n.path, n.text]));
    let hit = 0;
    const missed: string[] = [];
    let he = 0;
    let heHit = 0;
    for (const [a, b] of pairs) {
      const got = relatedNotes(index, body(byPath.get(a)!), { self: a, limit: 5 }).map((h) => h.path);
      expect(got).not.toContain(a);
      const ok = got.includes(b);
      if (ok) hit++;
      else missed.push(`${a}→${b}`);
      if (a.startsWith("he/")) {
        he++;
        if (ok) heHit++;
      }
    }
    const recall = hit / pairs.length;
    console.info(`[W2.2] gold recall@5 ${(recall * 100).toFixed(0)}% (Hebrew ${((heHit / he) * 100).toFixed(0)}%); missed ${missed.slice(0, 6).join(", ")}`);
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });

  it("ranking a paragraph against 10,000 notes fits the 150 ms budget after the debounce", () => {
    const { notes } = goldVault();
    const index = new Bm25Index();
    for (let i = 0; i < 10_000; i++) {
      const n = notes[i % notes.length];
      index.set(`${n.path}#${i}`, `${n.text}\nextra words ${i % 97} lorem ipsum`, nameOf(n.path));
    }
    const paragraph = body(notes[3].text).repeat(6);
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      relatedNotes(index, paragraph, { self: "x", limit: 5 });
      times.push(performance.now() - t0);
    }
    const best = Math.min(...times);
    console.info(`[W2.2] 10,000 notes: related in ${times.map((t) => t.toFixed(1)).join(" / ")} ms + ${RELATED_DELAY_MS} ms debounce`);
    expect(RELATED_DELAY_MS + best).toBeLessThan(150);
  });

  it("the query is the paragraph's rarest words, at most 16", () => {
    const index = new Bm25Index();
    index.set("a", "common common rare", "a");
    index.set("b", "common", "b");
    const terms = salientTerms(index, "common rare " + Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "));
    expect(new Set(terms.map((t) => t.group)).size).toBeLessThanOrEqual(16);
    expect(terms.some((t) => t.term === "rare")).toBe(true);
  });

  it("paragraphAt takes the block between blank lines", () => {
    const doc = "one\n\ntwo three\nfour\n\nfive";
    expect(paragraphAt(doc, 7)).toEqual({ from: 5, to: 19, text: "two three\nfour" });
    expect(paragraphAt(doc, 0).text).toBe("one");
    expect(paragraphAt(doc, doc.length).text).toBe("five");
  });

  it("fuses embedding hits by reciprocal rank", () => {
    const f = fuseRanks([[{ path: "a" }, { path: "b" }], [{ path: "b" }]], [1, 1.2]);
    expect([...f].sort((x, y) => y[1] - x[1])[0][0]).toBe("b");
  });
});

describe("suggested links", () => {
  const titles = titleEntries(["Project Aurora.md", "notes/פרויקט אלפא.md", "Hiring Plan.md", "a/Dup.md", "b/Dup.md", "Ok.md"]);

  it("finds unlinked mentions, Hebrew after a prefix letter, never in code or links, never the word being typed", () => {
    expect(titles.map((t) => t.name).sort()).toEqual(["Hiring Plan", "Project Aurora", "פרויקט אלפא"]);
    const p = "We discussed project aurora and בפרויקט אלפא; `Hiring Plan` is code and [[Hiring Plan]] is linked.";
    const hints = linkHints(p, 100, titles);
    expect(hints.map((h) => [h.name, p.slice(h.from - 100, h.to - 100)])).toEqual([
      ["Project Aurora", "project aurora"],
      ["פרויקט אלפא", "פרויקט אלפא"],
    ]);
    expect(linkText(hints[0], "project aurora")).toBe("[[Project Aurora|project aurora]]");
    const typing = linkHints("about Project Aurora", 0, titles, { cursor: 20 });
    expect(typing).toEqual([]);
    expect(linkHints("about Project Aurora", 0, titles, { linked: new Set(["project aurora"]) })).toEqual([]);
    expect(linkHints("about Project Aurora", 0, titles, { self: "Project Aurora.md" })).toEqual([]);
  });

  describe("editor plugin", () => {
    afterEach(() => vi.useRealTimers());

    it("does nothing per keystroke; after a pause it shows hints; Link converts one mention as one undoable edit", () => {
      vi.useFakeTimers();
      const pause = vi.fn((_v: EditorView, para: { from: number; text: string }, cursor: number) => linkHints(para.text, para.from, titles, { cursor }));
      const view = new EditorView({ state: EditorState.create({ doc: "", extensions: [relatedExtension({ pause, label: (h) => `Link to ${h.name}` }, 100)] }), parent: document.body });
      vi.advanceTimersByTime(150);
      pause.mockClear();
      const text = "We met about Project Aurora today. ";
      for (const ch of text) view.dispatch({ changes: { from: view.state.doc.length, insert: ch }, selection: { anchor: view.state.doc.length + 1 } });
      expect(pause).not.toHaveBeenCalled();
      vi.advanceTimersByTime(99);
      expect(pause).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(view.state.doc.toString()).toBe(text);
      const [hint] = currentHints(view);
      expect(hint.name).toBe("Project Aurora");
      expect(view.dom.querySelector(".cm-related-hint")?.getAttribute("title")).toBe("Link to Project Aurora");
      expect(acceptHint(view, hint)).toBe(true);
      expect(view.state.doc.toString()).toBe("We met about [[Project Aurora]] today. ");
      view.destroy();
    });

    it("typing inside a hint drops it until the next pause", () => {
      vi.useFakeTimers();
      const view = new EditorView({ state: EditorState.create({ doc: "x Hiring Plan y", extensions: [relatedExtension({ pause: (_v, p) => linkHints(p.text, p.from, titles), label: (h) => h.name }, 50)] }), parent: document.body });
      vi.advanceTimersByTime(60);
      expect(currentHints(view)).toHaveLength(1);
      view.dispatch({ changes: { from: 5, insert: "Z" } });
      expect(currentHints(view)).toHaveLength(0);
      view.destroy();
    });
  });
});

describe("off per note and folder", () => {
  afterEach(() => localStorage.removeItem("lumen.related.offFolders"));

  it("front matter related: false, or a folder turned off", () => {
    expect(noteOptsOut("---\nrelated: false\n---\nx")).toBe(true);
    expect(noteOptsOut("---\ntitle: x\n---\nrelated: false")).toBe(false);
    setFolderOff("private/", true);
    expect(offFolders()).toEqual(["private"]);
    expect(folderOff("private/a.md")).toBe(true);
    expect(folderOff("privateer/a.md")).toBe(false);
    expect(relatedOff("work/a.md", "---\nrelated: no\n---\n")).toBe(true);
    setFolderOff("private", false);
    expect(relatedOff("private/a.md", "")).toBe(false);
  });
});
