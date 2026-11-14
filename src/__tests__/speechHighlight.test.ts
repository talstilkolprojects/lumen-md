/** T32 — the read-aloud highlight is a decoration, never the selection. */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showSpokenRange, showSpokenWord, speechHighlightExtension, spokenRangeField, spokenWordField } from "../editor/speechHighlight";

function ranges(view: EditorView): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  view.state.field(spokenRangeField).between(0, view.state.doc.length, (a, b) => {
    out.push([a, b]);
  });
  return out;
}

describe("speech highlight", () => {
  it("highlights the sentence without selecting it, so typing can't replace it", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "First one. Second one.", extensions: speechHighlightExtension() }) });
    showSpokenRange(view, { from: 0, to: 10 });
    expect(view.state.selection.main.empty).toBe(true);
    expect(ranges(view)).toEqual([[0, 10]]);
    // The user types at the cursor (position 0) during playback.
    view.dispatch(view.state.replaceSelection("X"));
    expect(view.state.doc.toString()).toBe("XFirst one. Second one.");
    showSpokenRange(view, null);
    expect(ranges(view)).toEqual([]);
    view.destroy();
  });

  it("clamps a range past the end of an edited document", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "short", extensions: speechHighlightExtension() }) });
    showSpokenRange(view, { from: 2, to: 99 });
    expect(ranges(view)).toEqual([[2, 5]]);
    view.destroy();
  });

  it("marks the spoken word inside the sentence (plan W5.6); a new sentence clears it", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "שלום עולם. מה שלומך.", extensions: speechHighlightExtension() }) });
    const words = () => {
      const out: Array<[number, number]> = [];
      view.state.field(spokenWordField).between(0, view.state.doc.length, (a, b) => {
        out.push([a, b]);
      });
      return out;
    };
    showSpokenRange(view, { from: 0, to: 10 });
    showSpokenWord(view, { from: 5, to: 9 });
    expect(words()).toEqual([[5, 9]]);
    expect(view.state.selection.main.empty).toBe(true);
    showSpokenRange(view, { from: 11, to: 20 });
    expect(words()).toEqual([]);
    showSpokenWord(view, { from: 14, to: 99 });
    expect(words()).toEqual([[14, 20]]);
    showSpokenRange(view, null);
    expect(words()).toEqual([]);
    view.destroy();
  });
});
