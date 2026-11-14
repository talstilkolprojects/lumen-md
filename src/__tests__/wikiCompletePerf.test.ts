/**
 * 4.5 acceptance: with 10,000 notes, `[[` suggestions take < 50 ms.
 *
 * Measured through the real path — the shared workspace index on an
 * in-memory OPFS, `linkCatalog()`, the shared matcher, and the source
 * editor's CodeMirror completion source. The budget is the plan's 50 ms;
 * on a developer machine one keystroke takes a few ms, which leaves CI a
 * wide margin. The first use builds the per-note entries (aliases, keys)
 * once and is reported separately.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex, ensureIndex, indexedFiles } from "../storage/workspaceIndex";
import { linkCatalog } from "../editor/wikiLinkData";
import { parseWikiQuery, wikiSuggestions } from "../editor/wikiComplete";
import { wikiLinkCompletions } from "../editor/wikiLinkCompletion";

const N = 10_000;
const EN = ["project", "alpha", "meeting", "notes", "budget", "design", "review", "travel", "recipe", "reading", "garden", "health"];
const HE = ["פרויקט", "שלום", "פגישה", "סיכום", "תקציב", "עיצוב", "מטבח", "גינה", "ספרים", "בריאות", "טיול", "לימודים"];

const QUERIES = ["", "a", "pro", "proj alp", "שָׁלוֹ", "פגיש", "area-3/me", "zzzz no match"];

describe("[[ completion over 10,000 notes", () => {
  beforeAll(async () => {
    installFakeOpfs();
    __resetWorkspaceIndex();
    for (let i = 0; i < N; i++) {
      const words = i % 2 ? [HE[i % 12], HE[(i * 7) % 12]] : [EN[i % 12], EN[(i * 5) % 12]];
      const name = `${words.join(" ")} ${i}`;
      const fm = i % 10 === 0 ? `---\naliases: [${EN[(i * 3) % 12]} ${i}, ${HE[(i * 5) % 12]} ${i}]\n---\n` : "";
      await writeWorkspaceFile(`area-${i % 20}/${name}.md`, `${fm}# ${name}\n\n## Section ${i % 7}\n\nText ^b${i}\n`);
    }
    await ensureIndex();
    expect(indexedFiles()).toHaveLength(N);
  }, 180_000);

  it("suggests in < 50 ms per keystroke", async () => {
    const t0 = performance.now();
    const first = wikiSuggestions(parseWikiQuery("[[pro")!, await linkCatalog(), undefined, { create: true });
    const cold = performance.now() - t0;
    expect(first.length).toBeGreaterThan(0);

    // Median of 7 runs per query: a GC pause or a busy CI core is not the matcher.
    const median: Record<string, number> = {};
    let worst = 0;
    for (const q of QUERIES) {
      const times: number[] = [];
      for (let r = 0; r < 7; r++) {
        const s = performance.now();
        const items = wikiSuggestions(parseWikiQuery(`[[${q}`)!, await linkCatalog(), undefined, { create: true });
        times.push(performance.now() - s);
        expect(items.length).toBeGreaterThan(0);
      }
      times.sort((a, b) => a - b);
      median[q || "(empty)"] = +times[3].toFixed(2);
      worst = Math.max(worst, times[6]);
    }
    const max = Math.max(...Object.values(median));
    // hygiene-allow: benchmark output
    console.log(`[[ suggestions, ${N} notes: first use ${cold.toFixed(1)} ms; median per query (ms) ${JSON.stringify(median)}; slowest single run ${worst.toFixed(1)} ms`);
    expect(max).toBeLessThan(50);
    // One-time build of the per-note entries: generous, but bounded.
    expect(cold).toBeLessThan(500);
  }, 60_000);

  it("the source editor's completion source answers in < 50 ms", async () => {
    await wikiLinkCompletions(new CompletionContext(EditorState.create({ doc: "[[", extensions: [markdown()] }), 2, false));
    const medians: number[] = [];
    for (const q of QUERIES) {
      const doc = `# Today\n\nSee [[${q}`;
      const state = EditorState.create({ doc, extensions: [markdown()] });
      const times: number[] = [];
      for (let r = 0; r < 5; r++) {
        const s = performance.now();
        const res = await wikiLinkCompletions(new CompletionContext(state, doc.length, false));
        times.push(performance.now() - s);
        expect(res?.options.length).toBeGreaterThan(0);
      }
      medians.push(times.sort((a, b) => a - b)[2]);
    }
    // hygiene-allow: benchmark output
    console.log(`CodeMirror source, ${N} notes: median per query up to ${Math.max(...medians).toFixed(2)} ms over ${QUERIES.length} queries`);
    expect(Math.max(...medians)).toBeLessThan(50);
  });

  it("the Hebrew query with niqqud finds the Hebrew notes", async () => {
    const items = wikiSuggestions(parseWikiQuery("[[שָׁלוֹם")!, await linkCatalog());
    expect(items[0].label.startsWith("שלום")).toBe(true);
  });
});
