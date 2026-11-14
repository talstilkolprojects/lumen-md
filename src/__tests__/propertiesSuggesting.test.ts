/**
 * #228 P1: a Properties-panel edit made while suggesting mode is on becomes
 * a tracked change (CriticMarkup), in the source editor and without one.
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { suggestingExtension } from "../editor/suggestingExtension";
import { minimalChange, propertiesTransaction, trackedPropertiesText } from "../editor/propertiesEdit";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

const NOTE = "---\nstatus: draft\n---\n# Note\n";
const edited = NOTE.replace("draft", "done");

describe("properties edits in suggesting mode", () => {
  const state = () => EditorState.create({ doc: NOTE, extensions: [suggestingExtension(true)] });

  it("the old untagged dispatch bypassed the suggesting filter (the bug)", () => {
    const s = state();
    const out = s.update({ changes: minimalChange(NOTE, edited)! }).state.doc.toString();
    expect(out).toBe(edited);
  });

  it("the source editor records the edit as CriticMarkup", () => {
    const s = state();
    const out = s.update(propertiesTransaction(minimalChange(NOTE, edited)!)).state.doc.toString();
    expect(out).toBe("---\nstatus: d{~~raft~>one~~}\n---\n# Note\n");
  });

  it("without a source editor the store text gets the same tracked change", () => {
    const viaEditor = state().update(propertiesTransaction(minimalChange(NOTE, edited)!)).state.doc.toString();
    expect(trackedPropertiesText(NOTE, minimalChange(NOTE, edited)!, null)).toBe(viaEditor);
  });

  it("outside suggesting mode the edit applies directly", () => {
    const s = EditorState.create({ doc: NOTE, extensions: [suggestingExtension(false)] });
    expect(s.update(propertiesTransaction(minimalChange(NOTE, edited)!)).state.doc.toString()).toBe(edited);
  });

  it("minimalChange is null for no change", () => {
    expect(minimalChange(NOTE, NOTE)).toBeNull();
  });
});
