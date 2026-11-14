/**
 * Plan 5.9 — text the AI wrote is marked.
 *
 * Acceptance: 100% of the AI insertions are marked. Every AI command runs
 * through the agent runtime (5.5, allThroughRuntime.test.ts), so the test
 * runs each document-writing agent through the runtime and inserts its
 * answer the ways the commands do: at the cursor, over a selection, as a
 * whole-document update, reformatted line by line, and streamed. Every
 * character of every answer must end up marked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import {
  aiSpansIn,
  clearAiOutputs,
  diffMiddle,
  loadSpans,
  noteAiOutput,
  readAuthorshipFooter,
  recentAiTexts,
  saveSpans,
  subtract,
  withAuthorshipFooter,
  type Span,
} from "../ai/authorship";
import { aiAuthored, aiSpansField, setAiSpans } from "../editor/aiAuthorship";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent, streamAgent } from "../agents/runtime";
import { answererAgent, completerAgent, memoSummarizerAgent, rewriterAgent, templaterAgent, writerAgent } from "../agents/defs";
import type { AgentDefinition, AgentInput } from "../agents/types";
import { fakeExecutor, reply, sequence } from "./helpers/fakeExecutor";

function editor(doc = "", spans: readonly Span[] = []) {
  let state = EditorState.create({ doc, extensions: [aiSpansField] });
  if (spans.length) state = state.update({ effects: setAiSpans.of(spans) }).state;
  return {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
    spans: () => state.field(aiSpansField),
    marked: () => state.field(aiSpansField).map(([a, b]) => state.doc.sliceString(a, b)),
  };
}

/** True when every non-space character of `answer`'s occurrence in the doc is inside a span. */
function fullyMarked(doc: string, spans: readonly Span[], answer: string): boolean {
  const at = doc.indexOf(answer.trim());
  if (at < 0) return false;
  for (let i = at; i < at + answer.trim().length; i++) {
    if (/\s/.test(doc[i])) continue;
    if (!spans.some(([a, b]) => i >= a && i < b)) return false;
  }
  return true;
}

beforeEach(() => {
  clearAiOutputs();
  localStorage.clear();
});

describe("matching an insertion against recent answers", () => {
  const answer = "Cats sleep for most of the day.\nThey hunt at dawn and dusk.";

  it("marks an answer inserted as is, or as a piece of the answer", () => {
    expect(aiSpansIn(answer, [answer])).toEqual([[0, answer.length]]);
    expect(aiSpansIn("  most of the day ", [answer])).toEqual([[2, 17]]);
  });

  it("finds the answer inside a larger insertion, and its long lines when reformatted", () => {
    const doc = `My notes\n\n${answer}\n\nEnd`;
    expect(aiSpansIn(doc, [answer])).toEqual([[10, 10 + answer.length]]);
    const quoted = "> Cats sleep for most of the day.\n> They hunt at dawn and dusk.";
    expect(aiSpansIn(quoted, [answer]).map(([a, b]) => quoted.slice(a, b))).toEqual(["Cats sleep for most of the day.", "They hunt at dawn and dusk."]);
  });

  it("does not mark short markup or unrelated text", () => {
    expect(aiSpansIn("**", ["**bold** text"])).toEqual([]);
    expect(aiSpansIn("- [ ] ", ["- [ ] buy milk"])).toEqual([]);
    expect(aiSpansIn("Dogs bark at night.", [answer])).toEqual([]);
    expect(aiSpansIn(answer, [])).toEqual([]);
  });

  it("forgets answers after a while, and keeps JSON answers' text", () => {
    noteAiOutput("r1", "old answer", 0);
    expect(recentAiTexts(60 * 60_000)).toEqual([]);
    noteAiOutput("r2", { tasks: [{ title: "Write the report" }], n: 3 });
    expect(recentAiTexts()).toEqual(["Write the report"]);
  });

  it("span arithmetic", () => {
    expect(subtract([[0, 10]], 3, 5)).toEqual([[0, 3], [5, 10]]);
    expect(subtract([[0, 10], [20, 30]], 5, 25)).toEqual([[0, 5], [25, 30]]);
    expect(diffMiddle("abcXYZdef", "abcQdef")).toEqual({ start: 3, endBefore: 6, endAfter: 4 });
  });
});

describe("the editor field", () => {
  const answer = "The meeting moved to Tuesday at ten.";

  it("marks an AI insertion at the cursor and over a selection", () => {
    noteAiOutput("r", answer);
    const ed = editor("Note: ");
    ed.dispatch({ changes: { from: 6, insert: answer } });
    expect(ed.marked()).toEqual([answer]);

    const ed2 = editor("Note: draft text here.");
    ed2.dispatch({ changes: { from: 6, to: 22, insert: answer } });
    expect(ed2.marked()).toEqual([answer]);
  });

  it("never marks what the user types, pastes or drops", () => {
    noteAiOutput("r", answer);
    for (const userEvent of ["input.type", "input.paste", "input.drop"]) {
      const ed = editor("");
      ed.dispatch({ changes: { from: 0, insert: answer }, userEvent });
      expect(ed.spans(), userEvent).toEqual([]);
    }
  });

  it("typing inside a mark turns that part into ordinary text; deleting shrinks it", () => {
    const ed = editor(answer, [[0, answer.length]]);
    ed.dispatch({ changes: { from: 4, insert: "big " }, userEvent: "input.type" });
    expect(ed.marked()).toEqual(["The ", "meeting moved to Tuesday at ten."]);
    ed.dispatch({ changes: { from: 4 + 4 + 8, to: 4 + 4 + 14 }, userEvent: "delete.backward" });
    expect(ed.marked().join("")).toBe("The meeting to Tuesday at ten.");
  });

  it("a whole-document update keeps the marks outside the change and finds the answer in it", () => {
    const before = `# Plan\n\n${answer}\n\nMore`;
    const ed = editor(before, [[8, 8 + answer.length]]);
    const second = "Bring the slides and the budget sheet.";
    noteAiOutput("r2", second);
    const after = `${before}\n\n${second}\n`;
    ed.dispatch({ changes: { from: 0, to: before.length, insert: after } });
    expect(ed.marked()).toEqual([answer, second]);
  });

  it("the aiAuthored annotation marks a short accepted completion", () => {
    const ed = editor("Dear Ma");
    ed.dispatch({ changes: { from: 7, insert: "ria," }, annotations: aiAuthored.of(true) });
    expect(ed.marked()).toEqual(["ria,"]);
  });
});

describe("100% of the AI insertions are marked (acceptance)", () => {
  beforeEach(() => resetExecutors());

  const writers: Array<[string, AgentDefinition<AgentInput, unknown>, AgentInput, string]> = [
    ["writer", writerAgent as never, { text: "Write about the launch." }, "The launch is set for the first week of June, after the beta closes."],
    ["templater", templaterAgent as never, { text: "Meeting notes", extra: { templateId: "meeting" } }, "## Agenda\n\n- Review the quarterly numbers together\n- Agree on the hiring plan for Q3"],
    ["rewriter", rewriterAgent as never, { text: "we ship soon", extra: { instruction: "formal" } }, "We will ship the release shortly."],
    ["completer (ghost)", completerAgent as never, { text: "The quick brown", extra: { mode: "ghost" } }, " fox jumps over the lazy dog"],
    ["answerer", answererAgent as never, { text: "When?", extra: { context: "📄 [1] a.md\nTuesday", history: [] } }, 'The launch is on Tuesday [1] "Tuesday"'],
    ["memo summarizer", memoSummarizerAgent as never, { text: "We met and decided to ship on Tuesday." }, "- Met with the whole team today.\n- Decided to ship on Tuesday."],
  ];

  type Form = [string, (answer: string) => { doc: string; spec: (doc: string) => TransactionSpec }];
  const forms: Form[] = [
    ["at the cursor", () => ({ doc: "Intro.\n\n", spec: (a) => ({ changes: { from: 8, insert: a } }) })],
    ["over a selection", () => ({ doc: "Intro. old text here", spec: (a) => ({ changes: { from: 7, to: 20, insert: a } }) })],
    ["as a whole-document update", () => ({ doc: "Intro.", spec: (a) => ({ changes: { from: 0, to: 6, insert: `Intro.\n\n${a}\n\nOutro.` } }) })],
  ];

  for (const [name, def, input, answer] of writers) {
    for (const [formName, form] of forms) {
      it(`${name}, inserted ${formName}`, async () => {
        registerExecutor(fakeExecutor(sequence(answer)));
        const run = await runAgent(def, input, { executor: "ollama" });
        expect(run.status).toBe("ok");
        const text = String(run.output);
        const { doc, spec } = form(text);
        const ed = editor(doc);
        ed.dispatch(spec(text));
        expect(fullyMarked(ed.state.doc.toString(), ed.spans(), text)).toBe(true);
      });
    }
  }

  it("a streamed answer, inserted piece by piece", async () => {
    const pieces = ["The launch is ", "set for June, ", "after the beta."];
    registerExecutor(
      fakeExecutor(async (req) => {
        for (const p of pieces) req.onDelta?.(p);
        return reply(pieces.join(""));
      }),
    );
    const ed = editor("");
    let at = 0;
    for await (const chunk of streamAgent(writerAgent, { text: "launch" }, { executor: "ollama" })) {
      ed.dispatch({ changes: { from: at, insert: chunk } });
      at += chunk.length;
    }
    expect(ed.state.doc.toString()).toBe(pieces.join(""));
    expect(fullyMarked(ed.state.doc.toString(), ed.spans(), pieces.join(""))).toBe(true);
  });
});

describe("storage and export", () => {
  it("restores only the marks whose text is unchanged", () => {
    const doc = "AI line one here.\nMy own line.\nAI line two here.";
    saveSpans("a.md", doc, [[0, 17], [31, 48]]);
    expect(loadSpans("a.md", doc)).toEqual([[0, 17], [31, 48]]);
    const edited = doc.replace("two", "2");
    expect(loadSpans("a.md", edited)).toEqual([[0, 17]]);
    saveSpans("a.md", doc, []);
    expect(localStorage.getItem("lumen.ai.authorship")).toBeNull();
  });

  it("exports the marks as a footer comment and reads them back", () => {
    const doc = "Mine.\n\nThe AI wrote this paragraph.\n";
    const out = withAuthorshipFooter(doc, [[7, 35]]);
    expect(out).toBe(`${doc}\n<!-- lumen-ai-authorship v1: 7-35 -->\n`);
    expect(readAuthorshipFooter(out)).toEqual({ body: doc, spans: [[7, 35]] });
    expect(withAuthorshipFooter(doc, [])).toBe(doc);
    // Exporting again replaces the footer instead of adding a second one.
    expect(withAuthorshipFooter(out, [[0, 4]])).toBe(`${doc}\n<!-- lumen-ai-authorship v1: 0-4 -->\n`);
  });
});
