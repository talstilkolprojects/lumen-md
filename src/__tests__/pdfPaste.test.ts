/**
 * Plan W5.5: the paste suggestion and the palette command around
 * paste/pdfHebrew — the toast offers the fix with a preview, "Fix"
 * replaces exactly the pasted text as one change, and nothing is offered
 * for Hebrew that reads correctly.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { FIX_PDF_HEBREW_EVENT, fixSourceSelection, offerInSourceEditor, previewOf, runFixPdfHebrew } from "../paste/pdfPaste";
import { useToastStore } from "../store/useToastStore";

/** A CodeMirror-shaped view over a string. */
function fakeView(text: string, sel: { from: number; to: number } = { from: 0, to: 0 }) {
  const v = {
    text,
    sel,
    dispatched: 0,
    userEvents: [] as string[],
    state: {
      get doc() {
        return { length: v.text.length, sliceString: (a: number, b?: number) => v.text.slice(a, b) };
      },
      get selection() {
        return { main: v.sel };
      },
    },
    dispatch(spec: { changes: { from: number; to: number; insert: string }; userEvent?: string }) {
      v.dispatched++;
      v.userEvents.push(spec.userEvent ?? "");
      v.text = v.text.slice(0, spec.changes.from) + spec.changes.insert + v.text.slice(spec.changes.to);
    },
    focus() {},
  };
  return v;
}

const REVERSED = "2024 תנשב PDF-ה ץבוק";
const LOGICAL = "קובץ ה-PDF בשנת 2024";

beforeEach(() => useToastStore.getState().clear());

describe("after a paste in the source editor", () => {
  it("offers the fix with a preview; Fix replaces only the pasted text, once", () => {
    const view = fakeView(`לפני\n${REVERSED}\nאחרי`);
    expect(offerInSourceEditor(view, 5, REVERSED)).toBe(true);
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.title).toMatch(/reversed/i);
    expect(toast.body).toContain(LOGICAL);
    toast.action!.run();
    expect(view.text).toBe(`לפני\n${LOGICAL}\nאחרי`);
    expect(view.dispatched).toBe(1);
    expect(view.userEvents).toEqual(["input.pdffix"]);
  });

  it("finds the pasted text again after typing moved it", () => {
    const view = fakeView(REVERSED);
    offerInSourceEditor(view, 0, REVERSED);
    view.text = "כותרת\n" + view.text;
    useToastStore.getState().toasts.at(-1)!.action!.run();
    expect(view.text).toBe("כותרת\n" + LOGICAL);
  });

  it("says so when the pasted text is gone", () => {
    const view = fakeView(REVERSED);
    offerInSourceEditor(view, 0, REVERSED);
    view.text = "משהו אחר";
    useToastStore.getState().toasts.at(-1)!.action!.run();
    expect(view.text).toBe("משהו אחר");
    expect(useToastStore.getState().toasts.at(-1)!.kind).toBe("warning");
  });

  it("offers nothing for Hebrew that reads correctly", () => {
    expect(offerInSourceEditor(fakeView(LOGICAL), 0, LOGICAL)).toBe(false);
    expect(useToastStore.getState().toasts.length).toBe(0);
  });

  it("previews long text on one line, shortened", () => {
    const p = previewOf("שורה\n".repeat(80));
    expect(p.includes("\n")).toBe(false);
    expect(p.length).toBeLessThanOrEqual(161);
  });
});

describe("the palette command", () => {
  it("fixes the selection in the source editor", () => {
    const view = fakeView(`x ${REVERSED} y`, { from: 2, to: 2 + REVERSED.length });
    expect(fixSourceSelection(view)).toBe(null);
    expect(view.text).toBe(`x ${LOGICAL} y`);
  });

  it("asks for a selection, and leaves correct text alone", () => {
    expect(fixSourceSelection(fakeView("abc"))).toMatch(/select/i);
    const ok = fakeView(LOGICAL, { from: 0, to: LOGICAL.length });
    expect(fixSourceSelection(ok)).toMatch(/nothing to fix/i);
    expect(ok.dispatched).toBe(0);
  });

  it("reaches the mounted editor through the event, and says when none is", () => {
    runFixPdfHebrew();
    expect(useToastStore.getState().toasts.at(-1)!.title).toMatch(/editor/i);
    const view = fakeView(REVERSED, { from: 0, to: REVERSED.length });
    const handler = (e: Event) => (e as CustomEvent<{ done: (m: string | null) => void }>).detail.done(fixSourceSelection(view));
    window.addEventListener(FIX_PDF_HEBREW_EVENT, handler);
    runFixPdfHebrew();
    window.removeEventListener(FIX_PDF_HEBREW_EVENT, handler);
    expect(view.text).toBe(LOGICAL);
    expect(useToastStore.getState().toasts.at(-1)!.kind).toBe("success");
  });
});
