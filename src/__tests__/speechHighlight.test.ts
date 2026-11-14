/** T32 — the read-aloud highlight is a decoration, never the selection. */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showSpokenRange, speechHighlightExtension, spokenRangeField } from "../editor/speechHighlight";

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
});
