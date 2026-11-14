/**
 * Plan W5.6 acceptance: "Show niqqud" is for display only — the note's
 * bytes are the same before and after, and only read-only rendered text is
 * pointed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDisplayNikud, applyDisplayNikud, clearDisplayNikud, isSamePointed, watchDisplayNikud, type PointMany } from "../reading/displayNikud";
import { removeNikud } from "../text/nikud";
import { useAppStore } from "../store/useStore";

const QAMATS = "ָ";
/** A stand-in for the model: a qamats after every Hebrew letter. */
const fakePoint: PointMany = async (texts) => texts.map((s) => s.replace(/([א-ת])/g, `$1${QAMATS}`));

const NOTE = "# שלום\n\nפסקה **מודגשת** עם `קוד` ו-English.\n";

function preview(): HTMLElement {
  document.body.innerHTML = `
    <div class="prose-lumen" id="pv">
      <h1>שלום</h1>
      <p>פסקה <strong>מודגשת</strong> עם <code>קוד</code> ו-English.</p>
      <p data-no-nikud>לא לנקד</p>
      <p>שָׁלוֹם מנוקד</p>
      <pre><code>const x = "עברית";</code></pre>
    </div>
    <div class="prose-lumen wysiwyg-root" contenteditable="true" id="ed"><p>עורך</p></div>`;
  return document.getElementById("pv")!;
}

const bytes = (s: string) => Array.from(new TextEncoder().encode(s));

beforeEach(() => {
  __resetDisplayNikud();
  useAppStore.getState().setContent(NOTE);
});

describe("display-only niqqud", () => {
  it("points the rendered preview and leaves the note byte for byte as it was", async () => {
    const before = bytes(useAppStore.getState().doc.content);
    const root = preview();
    const shown = await applyDisplayNikud(root, fakePoint);
    // h1, "פסקה ", "מודגשת", " עם ", " ו-English." — not the code, the marked, the pointed or the <pre> text
    expect(shown).toBe(5);
    expect(root.querySelector("h1")!.textContent).toBe(`ש${QAMATS}ל${QAMATS}ו${QAMATS}ם${QAMATS}`);
    expect(root.querySelector("strong")!.textContent).toContain(QAMATS);
    expect(bytes(useAppStore.getState().doc.content)).toEqual(before);
    clearDisplayNikud(root);
    expect(bytes(useAppStore.getState().doc.content)).toEqual(before);
  });

  it("never points code, an editable surface, text marked data-no-nikud, or text the author pointed", async () => {
    const root = preview();
    await applyDisplayNikud(root, fakePoint);
    expect(root.querySelector("p code")!.textContent).toBe("קוד");
    expect(root.querySelector("pre")!.textContent).toBe('const x = "עברית";');
    expect(root.querySelector("[data-no-nikud]")!.textContent).toBe("לא לנקד");
    expect(root.querySelectorAll("p")[2].textContent).toBe("שָׁלוֹם מנוקד");
    // The WYSIWYG editor is `.prose-lumen` too: pointing it would edit the note.
    await applyDisplayNikud(document.getElementById("ed")!, fakePoint);
    expect(document.getElementById("ed")!.textContent).toBe("עורך");
  });

  it("turning it off restores every node's own text exactly", async () => {
    const root = preview();
    const html = root.innerHTML;
    await applyDisplayNikud(root, fakePoint);
    expect(root.innerHTML).not.toBe(html);
    clearDisplayNikud(root);
    expect(root.innerHTML).toBe(html);
  });

  it("a result that changes a letter is never shown", async () => {
    const root = preview();
    const bad: PointMany = async (texts) => texts.map((s) => s.replace(/ש/g, "ס"));
    expect(await applyDisplayNikud(root, bad)).toBe(5);
    expect(root.querySelector("h1")!.textContent).toBe("שלום");
    expect(isSamePointed("שלום", `ש${QAMATS}לום`)).toBe(true);
    expect(isSamePointed("שלום", "סלום")).toBe(false);
  });

  it("re-rendered text is pointed again from the cache, without another model call", async () => {
    const root = preview();
    const point = vi.fn(fakePoint);
    await applyDisplayNikud(root, point);
    const calls = point.mock.calls.length;
    root.querySelector("h1")!.textContent = "שלום";
    await applyDisplayNikud(root, point);
    expect(point.mock.calls.length).toBe(calls);
    expect(root.querySelector("h1")!.textContent).toContain(QAMATS);
  });

  it("the watcher points a preview that re-renders, and stop() restores it", async () => {
    const root = preview();
    const w = watchDisplayNikud(fakePoint, { delayMs: 5 });
    await w.ready;
    expect(root.querySelector("h1")!.textContent).toContain(QAMATS);
    const p = document.createElement("p");
    p.textContent = "שורה חדשה";
    root.appendChild(p);
    await vi.waitFor(() => expect(p.textContent).toContain(QAMATS), { timeout: 2000, interval: 10 });
    w.stop();
    expect(p.textContent).toBe("שורה חדשה");
    expect(root.querySelector("h1")!.textContent).toBe("שלום");
    expect(removeNikud(root.querySelector("strong")!.textContent ?? "")).toBe(root.querySelector("strong")!.textContent);
    expect(document.getElementById("ed")!.textContent).toBe("עורך");
  });
});
