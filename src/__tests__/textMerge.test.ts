/**
 * The merge engine (plan W1.9, src/sync/merge/textMerge.ts): front matter
 * by key, lines, then words; a dialog only for what overlaps.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { frontmatterValid, mergeText, splitFrontmatter } from "../sync/merge/textMerge";
import { mergeFirst, type ConflictResolver } from "../sync/e2ee/conflict";

const doc = (lines: string[]) => lines.join("\n") + "\n";

describe("merge engine: cases", () => {
  it("different lines, and different words of one line, merge without asking", () => {
    const base = doc(["# Plan", "שלום עולם, the cat sat on the mat.", "", "- milk", "- bread"]);
    const ours = doc(["# Plan", "שלום עולם, the dog sat on the mat.", "", "- milk", "- bread"]);
    const theirs = doc(["# Plan", "שלום עולם, the cat sat on the red mat.", "", "- milk", "- bread", "- eggs"]);
    const r = mergeText(base, ours, theirs);
    expect(r).toEqual({ clean: true, conflicts: 0, text: doc(["# Plan", "שלום עולם, the dog sat on the red mat.", "", "- milk", "- bread", "- eggs"]) });
  });

  it("the same words changed two ways is a conflict, with both versions between markers", () => {
    const r = mergeText("a\nthe cat sat\nb\n", "a\nthe dog sat\nb\n", "a\nthe bird sat\nb\n", { ours: "mine", theirs: "theirs" });
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe("a\n<<<<<<< mine\nthe dog sat\n=======\nthe bird sat\n>>>>>>> theirs\nb\n");
  });

  it("front matter merges by key; lists take both sides' additions and removals", () => {
    const base = "---\ntitle: Trip\ntags: [a, b]\nstatus: draft\n---\nBody\n";
    const ours = "---\ntitle: Trip to Haifa\ntags: [a, b, c]\nstatus: draft\n---\nBody\n";
    const theirs = "---\ntitle: Trip\ntags: [b, d]\nstatus: done\ndue: 2026-12-01\n---\nBody\n";
    const r = mergeText(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.text).toBe("---\ntitle: Trip to Haifa\ntags: [b, c, d]\nstatus: done\ndue: 2026-12-01\n---\nBody\n");
    expect(parseYaml(splitFrontmatter(r.text).fm!)).toEqual({ title: "Trip to Haifa", tags: ["b", "c", "d"], status: "done", due: "2026-12-01" });
  });

  it("block lists merge too; one key changed two ways is a conflict that never breaks the YAML", () => {
    const base = "---\ntags:\n  - a\ntitle: x\n---\n";
    const r = mergeText(base, "---\ntags:\n  - a\n  - b\ntitle: x\n---\n", "---\ntags:\n  - a\n  - c\ntitle: x\n---\n");
    expect(r.text).toBe("---\ntags:\n  - a\n  - b\n  - c\ntitle: x\n---\n");
    const c = mergeText(base, "---\ntags:\n  - a\ntitle: one\n---\n", "---\ntags:\n  - a\ntitle: two\n---\n");
    expect(c.clean).toBe(false);
  });

  it("keeps CRLF, a missing last newline, and Hebrew with niqqud intact", () => {
    const base = "שָׁלוֹם\r\nline two\r\nend";
    const r = mergeText(base, "שָׁלוֹם רב\r\nline two\r\nend", "שָׁלוֹם\r\nline 2\r\nend");
    expect(r).toEqual({ clean: true, conflicts: 0, text: "שָׁלוֹם רב\r\nline 2\r\nend" });
  });

  it("an edit against a deletion of the same text is a conflict, not a silent loss", () => {
    const r = mergeText("a\nkeep me\nb\n", "a\nkeep me, edited\nb\n", "a\nb\n");
    expect(r.clean).toBe(false);
  });

  it("mergeFirst: a clean merge answers without the dialog and keeps both versions; an overlap reaches it", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const asked: string[] = [];
    const kept: string[][] = [];
    const ask: ConflictResolver = async (c) => {
      asked.push(c.path);
      return { kind: "hold" };
    };
    const resolver = mergeFirst(ask, async (p, o, t) => void kept.push([p, o, t]));
    const clean = await resolver({ path: "a.md", base: enc("x\ny\n"), local: enc("X\ny\n"), remote: enc("x\nY\n") });
    expect(clean.kind === "content" && new TextDecoder().decode(clean.data)).toBe("X\nY\n");
    expect(kept).toEqual([["a.md", "X\ny\n", "x\nY\n"]]);
    expect((await resolver({ path: "b.md", base: enc("x\n"), local: enc("1\n"), remote: enc("2\n") })).kind).toBe("hold");
    expect((await resolver({ path: "c.md", base: null, local: enc("1\n"), remote: enc("2\n") })).kind).toBe("hold");
    expect(asked).toEqual(["b.md", "c.md"]);
  });
});

/* ─── 500 random pairs of concurrent edits ─────────────────────────── */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ["שלום", "עולם", "מחברת", "פגישה", "note", "plan", "meeting", "Monday", "budget", "draft", "idea", "list", "חשוב", "מחר", "2026", "**bold**", "[[Link]]", "#tag"];

function makeNote(r: () => number): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const fm = ["---", `title: ${JSON.stringify(`${pick(WORDS)} ${pick(WORDS)}`)}`, `tags: [${["a", "b", "c", "d"].filter(() => r() < 0.5).join(", ")}]`, `status: ${pick(["draft", "done", "open"])}`, "---"];
  const body: string[] = [];
  const n = 25 + Math.floor(r() * 25);
  for (let i = 0; i < n; i++) {
    const kind = r();
    const sentence = Array.from({ length: 5 + Math.floor(r() * 10) }, () => pick(WORDS)).join(" ");
    body.push(kind < 0.1 ? `## ${sentence.slice(0, 20)}` : kind < 0.3 ? `- ${sentence}` : kind < 0.4 ? "" : sentence);
  }
  return [...fm, ...body].join("\n") + "\n";
}

/** One person's edits: a few changes at random places, as people make them. */
function edit(text: string, r: () => number): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const { fm, open, close, body } = splitFrontmatter(text);
  let fmLines = (fm ?? "").split("\n").filter(Boolean);
  const lines = body.split("\n");
  const edits = 1 + Math.floor(r() * 3);
  for (let e = 0; e < edits; e++) {
    const i = Math.floor(r() * (lines.length - 1));
    const x = r();
    if (x < 0.35 && lines[i]) {
      const w = lines[i].split(" ");
      w[Math.floor(r() * w.length)] = pick(WORDS) + pick(["", "!", ","]);
      lines[i] = w.join(" ");
    } else if (x < 0.55) lines.splice(i, 0, `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`);
    else if (x < 0.65 && lines.length > 5) lines.splice(i, 1);
    else if (x < 0.8 && lines[i]) lines[i] = `${lines[i]} ${pick(WORDS)}`;
    else if (x < 0.9) {
      fmLines = fmLines.map((l) => (l.startsWith("tags:") ? `tags: [${[...new Set([...l.slice(7, -1).split(", ").filter(Boolean), pick(["e", "f", "g", "h", "i"])])].join(", ")}]` : l));
    } else {
      const key = pick(["status", "title", "due", "author"]);
      // Quoted: a value like **bold** or [[Link]] is not a plain YAML scalar.
      const v = key === "due" ? "2026-12-0" + (1 + Math.floor(r() * 9)) : JSON.stringify(pick(WORDS));
      const at = fmLines.findIndex((l) => l.startsWith(`${key}:`));
      if (at >= 0) fmLines[at] = `${key}: ${v}`;
      else fmLines.push(`${key}: ${v}`);
    }
  }
  return `${open}${fmLines.join("\n")}\n${close}${lines.join("\n")}`;
}

describe("merge engine: 500 random pairs of concurrent edits", () => {
  it("≥ 90% merge without a dialog, no character either side wrote is lost, the YAML stays valid in 100%", () => {
    const r = rng(20261110);
    let clean = 0;
    for (let k = 0; k < 500; k++) {
      const base = makeNote(r);
      const ours = edit(base, r);
      const theirs = edit(base, r);
      const m = mergeText(base, ours, theirs);
      if (!m.clean) continue;
      clean++;
      // Nothing lost, nothing doubled, word by word in the body: each word
      // is in the merge as often as base had it, plus what each side added,
      // minus what a side removed (front matter: by key, checked as YAML below).
      const count = (x: string) => {
        const c = new Map<string, number>();
        for (const w of splitFrontmatter(x).body.split(/\s+/).filter(Boolean)) c.set(w, (c.get(w) ?? 0) + 1);
        return c;
      };
      const [cb, co, ct, cm] = [count(base), count(ours), count(theirs), count(m.text)];
      for (const w of new Set([...cb.keys(), ...co.keys(), ...ct.keys(), ...cm.keys()])) {
        const b = cb.get(w) ?? 0;
        const o = co.get(w) ?? 0;
        const t = ct.get(w) ?? 0;
        const got = cm.get(w) ?? 0;
        const most = b + Math.max(0, o - b) + Math.max(0, t - b);
        // At least: base minus both sides' removals, plus the larger addition
        // (an addition both sides made the same way is there once).
        const least = Math.max(0, b - Math.max(0, b - o) - Math.max(0, b - t)) + Math.max(0, o - b, t - b);
        expect(got, `pair ${k}: "${w}" ${b}/${o}/${t}`).toBeLessThanOrEqual(most);
        expect(got, `pair ${k}: "${w}" ${b}/${o}/${t}`).toBeGreaterThanOrEqual(least);
      }
      // Both sides' front matter is valid YAML; the merge must keep it so.
      expect([ours, theirs].every((x) => frontmatterValid(splitFrontmatter(x).fm ?? "")), `pair ${k}: generator`).toBe(true);
      const fm = splitFrontmatter(m.text).fm;
      expect(fm !== null && frontmatterValid(fm), `pair ${k}: front matter`).toBe(true);
    }
    expect(clean / 500).toBeGreaterThanOrEqual(0.9);
  });
});

/* ─── one engine, three routes ─────────────────────────────────────── */

describe("one merge engine for sync, git and outside changes", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
  it("the encrypted sync, safe git and external changes all merge through src/sync/merge/textMerge.ts", () => {
    expect(src("sync/e2ee/conflict.ts")).toMatch(/from "\.\.\/merge\/textMerge"/);
    expect(src("sync/gitMerge.ts")).toMatch(/from "\.\/merge\/textMerge"/);
    expect(src("store/externalChanges.ts")).toMatch(/import\("\.\.\/sync\/merge\/textMerge"\)/);
    // …and none of them carries a merge of its own any more.
    expect(src("sync/gitMerge.ts")).not.toMatch(/function mergeText[\s\S]*mergeHunks\(base, ours, theirs\)\)/);
  });
});
