/**
 * Plan W5.4: the palette commands — the "show direction marks" switch and
 * "clean marks and fix brackets" as one undoable change, in whichever
 * editor is mounted (the source editor's own transaction, the WYSIWYG
 * bridge, or the note text with an Undo button in the preview).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildBidiMarksCommands, runBidiFix } from "../editor/bidiMarksCommands";
import { bidiMarksShown, onBidiMarksChange, registerProseBidiFixer, setBidiMarksShown } from "../editor/bidiMarksSetting";
import { useToastStore } from "../store/useToastStore";

const NOTE = "\u200fשלום לכולם\n)הערה( בסוף\n```\n\u200fשלום\n```";
const FIXED = "שלום לכולם\n(הערה) בסוף\n```\n\u200fשלום\n```";

function deps(content: { value: string }, view: unknown = null) {
  return {
    getView: () => view as never,
    getContent: () => content.value,
    setContent: (s: string) => {
      content.value = s;
    },
  };
}

beforeEach(() => {
  useToastStore.getState().clear();
  setBidiMarksShown(false);
});

describe("direction-mark commands", () => {
  it("offers a show/hide switch and the fix, with labels that follow the switch", () => {
    const off = buildBidiMarksCommands(deps({ value: "" }));
    expect(off.map((c) => c.id)).toEqual(["view.bidiMarks", "edit.bidiFix"]);
    const label = off[0].label;
    let heard = 0;
    const unsub = onBidiMarksChange(() => heard++);
    off[0].action();
    unsub();
    expect(bidiMarksShown()).toBe(true);
    expect(heard).toBe(1);
    expect(buildBidiMarksCommands(deps({ value: "" }))[0].label).not.toBe(label);
    expect(localStorage.getItem("lumen.bidiMarks")).toBe("1");
  });

  it("in the preview: rewrites the note once and the toast's Undo restores it", async () => {
    const content = { value: NOTE };
    const r = await runBidiFix(deps(content));
    expect(r).toEqual({ removed: 1, swapped: 1 });
    expect(content.value).toBe(FIXED);
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.kind).toBe("success");
    toast.action!.run();
    expect(content.value).toBe(NOTE);
  });

  it("in the source editor: one transaction with every edit, no setContent", async () => {
    const content = { value: "unused" };
    const dispatched: Array<{ changes: Array<{ from: number; to: number; insert: string }>; userEvent: string }> = [];
    const view = { state: { doc: { toString: () => NOTE } }, dispatch: (tr: never) => dispatched.push(tr), focus: () => undefined };
    const r = await runBidiFix(deps(content, view));
    expect(r).toEqual({ removed: 1, swapped: 1 });
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].userEvent).toBe("input.bidifix");
    expect(dispatched[0].changes.length).toBe(3);
    expect(content.value).toBe("unused");
  });

  it("in WYSIWYG: the mounted editor's fixer runs", async () => {
    const content = { value: NOTE };
    const off = registerProseBidiFixer(() => ({ removed: 4, swapped: 0 }));
    const r = await runBidiFix(deps(content));
    off();
    expect(r).toEqual({ removed: 4, swapped: 0 });
    expect(content.value).toBe(NOTE);
  });

  it("says so when there is nothing to fix", async () => {
    const content = { value: "שלום (עולם)" };
    expect(await runBidiFix(deps(content))).toEqual({ removed: 0, swapped: 0 });
    expect(useToastStore.getState().toasts.at(-1)!.kind).toBe("info");
  });
});
