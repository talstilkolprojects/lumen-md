/**
 * W5.17 — tashkeel in the editor: hiding it leaves the text whole, removing
 * it is one change on the selection or the note.
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { removeTashkeelIn, tashkeelDecorations, toggleTashkeel } from "../editor/tashkeelView";

vi.mock("../ai/arabicStrings", () => ({}));

const POINTED = "مَدْرَسَةٌ";

describe("tashkeel in the editor", () => {
  function editor(doc: string, sel?: { anchor: number; head: number }) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({ state: EditorState.create({ doc, selection: sel }), parent });
  }

  it("hide shows the letters without the marks and leaves the text whole; toggling again shows them", () => {
    const view = editor(`نص: ${POINTED} و שָׁלוֹם`);
    expect(tashkeelDecorations(view).size).toBe(0);
    expect(toggleTashkeel(view)).toBe(true);
    expect(view.state.doc.toString()).toContain(POINTED);
    expect(tashkeelDecorations(view).size).toBe(5); // the five marks of مَدْرَسَةٌ, not the niqqud
    expect(toggleTashkeel(view)).toBe(false);
    expect(tashkeelDecorations(view).size).toBe(0);
    view.destroy();
  });

  it("remove takes the marks out of the selection only, as one change", () => {
    const text = `${POINTED} ${POINTED}`;
    const view = editor(text, { anchor: 0, head: POINTED.length });
    expect(removeTashkeelIn(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`مدرسة ${POINTED}`);
    view.dispatch({ selection: { anchor: 0 } });
    expect(removeTashkeelIn(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("مدرسة مدرسة");
    expect(removeTashkeelIn(view)).toBe(false);
    view.destroy();
  });
});
